/**
 * Chats an INTEGRATION starts — `spawn_chat` on the external MCP mount and
 * `POST /api/integration/chats`. One path for both, so the rules below cannot
 * hold on one surface and not the other.
 *
 * WHY THIS IS NOT `broker.spawnChat`. A spawned chat is an extension of the
 * chat that asked for it: it inherits the parent's posture, files under it,
 * reports back to it, and its consent card rides the parent session's
 * permission channel. An integration has no parent, so none of that applies —
 * and the card is the one that matters, because without a parent session
 * there is nowhere to put it.
 *
 * THE CONSENT IS THE GRANT. The owner approved `chats:create` for this token
 * (on the token form, or on the OAuth consent page, where it is its own line
 * saying the bot can start agents working in your repositories). Every chat
 * started under it is then approved by that, the same way every `chat_send`
 * is approved by `chats:write` — with two limits a grant cannot waive:
 *
 *   - THE MODE. A new chat runs in the project's own default posture, which is
 *     the owner's setting. A caller may name a different mode, but never one
 *     whose permission mode is `bypassPermissions`: a bot account that leaked
 *     must not be one call away from an agent running commands on this machine
 *     with nobody asked. Anything the chat does that needs a permission still
 *     lands in the Attention Queue in front of the human.
 *   - ATTRIBUTION. The brief is delivered through `ChatMessenger` as a
 *     `channel` row, so the transcript says who started it and the model is
 *     told it is hearing from an integration, not from the person.
 */
import type { Chat, Effort, HarnessKind, PermissionMode } from "@dispatch/shared";
import type { PeerSendResult } from "./chat-messenger.js";

export interface ChannelChatRequest {
  /** The integration's display name — the token name. */
  channel: string;
  projectId: string;
  /** The first message, delivered as the integration's. */
  prompt: string;
  title?: string;
  modeId?: string;
  provider?: HarnessKind;
  model?: string;
  effort?: Effort;
  personaId?: string;
}

export interface ChannelChat {
  chatId: string;
  title: string;
  projectId: string;
  projectName: string;
  provider: HarnessKind;
  model?: string;
  modeId?: string;
}

/** A refusal the caller caused — a 4xx on REST, a non-error answer on MCP. */
export class ChannelChatRefusal extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ChannelChatRefusal";
  }
}

export interface ChannelChatDeps {
  getProject: (id: string) => Promise<{ id: string; name: string } | null>;
  createChat: (input: {
    projectId: string;
    title?: string;
    modeId?: string;
    harness?: HarnessKind;
    model?: string;
    effort?: Effort;
    personaId?: string;
    purpose: { kind: string; label?: string };
  }) => Promise<Chat>;
  ensureSession: (chatId: string) => Promise<unknown>;
  /** The permission mode a mode id resolves to, project-authored modes included. */
  permissionModeOf: (modeId: string) => Promise<PermissionMode>;
  send: (input: { channel: { name: string }; to: string; message: string }) => Promise<PeerSendResult>;
}

export class ChannelChatService {
  constructor(private readonly deps: ChannelChatDeps) {}

  async create(req: ChannelChatRequest): Promise<ChannelChat> {
    const prompt = req.prompt.trim();
    if (!prompt) throw new ChannelChatRefusal("A new chat needs a first message — it starts with nothing else.");
    const project = await this.deps.getProject(req.projectId);
    if (!project) throw new ChannelChatRefusal(`No project "${req.projectId}". List them with project_list.`, 404);

    // Checked BEFORE the chat exists, so a refused mode costs no orphan row.
    // Only an explicitly named mode is checked: the project's own default is
    // the owner's choice, and second-guessing it here would make a bot-started
    // chat behave differently from one the owner opened themselves.
    if (req.modeId && (await this.deps.permissionModeOf(req.modeId)) === "bypassPermissions") {
      throw new ChannelChatRefusal(
        `Mode "${req.modeId}" bypasses permission prompts, which an integration may not start a chat in. ` +
          "Omit modeId to use the project's default, or pick a mode from mode_list that keeps prompts on.",
        403,
      );
    }

    const chat = await this.deps.createChat({
      projectId: project.id,
      ...(req.title ? { title: req.title } : {}),
      ...(req.modeId ? { modeId: req.modeId } : {}),
      ...(req.provider ? { harness: req.provider } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.personaId ? { personaId: req.personaId } : {}),
      purpose: { kind: "channel", label: `Started by ${req.channel}` },
    });
    await this.deps.ensureSession(chat.id);
    const sent = await this.deps.send({ channel: { name: req.channel }, to: chat.id, message: prompt });
    if (!sent.ok) {
      // The chat exists but never got its brief — say so with its id, rather
      // than reporting a failure the caller will "fix" by creating another.
      throw new ChannelChatRefusal(
        `Created chat ${chat.id} in ${project.name}, but its first message was refused: ${sent.message} ` +
          "Send it with chat_send once that clears — do not create another chat.",
        sent.refusal?.startsWith("rate-limited") ? 429 : 409,
      );
    }
    return {
      chatId: chat.id,
      title: chat.title,
      projectId: project.id,
      projectName: project.name,
      // `createChat` refuses a chat with no provider, so this is always set.
      provider: chat.harness!,
      ...(chat.model ? { model: chat.model } : {}),
      ...(chat.modeId ? { modeId: chat.modeId } : {}),
    };
  }
}
