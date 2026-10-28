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
 *
 * STOPPING (`chat_stop`, `POST /api/integration/chats/:id/stop`) lives here
 * too, because the case that motivated it is undoing a create: a connector
 * that spawned the same chat twice had no way to call the duplicate off. Two
 * powers, deliberately unequal:
 *
 *   - INTERRUPT any visible chat's running turn — the Composer's Stop button.
 *     Whatever lets a caller `chat_send` already grants this (delivery
 *     "interrupt"), so it is not a new power, only an honest name for it.
 *   - ARCHIVE only a chat THIS integration started. An archived chat drops out
 *     of the sidebar and the SPA has no control that brings it back, so a bot
 *     that could archive the owner's own chats could make their work vanish
 *     from view. Its own spawns — the duplicate — are fair game.
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
  /** A specific login to run on; omitted → the provider's default account. */
  subscriptionId?: string;
  agentId?: string;
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

/** What stopping a chat did. */
export interface ChannelChatStop {
  chatId: string;
  title: string;
  projectId: string;
  /** A turn was running and has been interrupted. False: there was nothing to stop. */
  interrupted: boolean;
  /** The chat is archived now (whether by this call or before it). */
  archived: boolean;
}

/**
 * The `purpose.label` a chat an integration started carries — and therefore
 * what decides whether that integration may archive it. One function for the
 * writer and the check, so the two cannot drift into different sentences.
 */
export function channelPurposeLabel(channel: string): string {
  return `Started by ${channel}`;
}

function startedBy(chat: Chat, channel: string): boolean {
  return chat.purpose?.kind === "channel" && chat.purpose.label === channelPurposeLabel(channel);
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
    subscriptionId?: string;
    agentId?: string;
    purpose: { kind: string; label?: string };
  }) => Promise<Chat>;
  ensureSession: (chatId: string) => Promise<unknown>;
  /** The permission mode a mode id resolves to, project-authored modes included. */
  permissionModeOf: (modeId: string) => Promise<PermissionMode>;
  send: (input: { channel: { name: string }; to: string; message: string }) => Promise<PeerSendResult>;
  getChat: (id: string) => Promise<Chat | null>;
  /** End the running turn — the Stop button's path. False when no turn was running. */
  interrupt: (chatId: string) => Promise<boolean>;
  /** Release the chat's live session; the next message resumes it. */
  stopSession: (chatId: string) => Promise<void>;
  /** Mark the chat archived and tell every client. */
  archive: (chatId: string) => Promise<void>;
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
      ...(req.subscriptionId ? { subscriptionId: req.subscriptionId } : {}),
      ...(req.agentId ? { agentId: req.agentId } : {}),
      purpose: { kind: "channel", label: channelPurposeLabel(req.channel) },
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

  /**
   * Interrupt a chat's running turn and, with `archive`, also release its
   * session and archive it — refused unless this integration started it (see
   * the file header for why the two are not equal). The caller has already
   * applied its project allowlist; an invisible chat never reaches here.
   */
  async stop(req: { channel: string; chatId: string; archive?: boolean }): Promise<ChannelChatStop> {
    const chat = await this.deps.getChat(req.chatId);
    if (!chat) throw new ChannelChatRefusal(`No chat "${req.chatId}" exists. Find the right id with chat_find.`, 404);
    // Checked before anything is touched, so a refused archive interrupts nothing.
    if (req.archive && !chat.archived && !startedBy(chat, req.channel)) {
      throw new ChannelChatRefusal(
        `Chat ${chat.id} was not started by ${req.channel}, so it cannot archive it — archiving hides a ` +
          "chat from the owner's sidebar. Call chat_stop without archive to interrupt its turn instead.",
        403,
      );
    }
    const interrupted = await this.deps.interrupt(chat.id);
    let archived = Boolean(chat.archived);
    if (req.archive && !archived) {
      // Released as well as interrupted: an archived chat nobody can see should
      // not keep a provider process alive. Its transcript and resume id stay,
      // so un-archiving and sending a message picks it back up.
      await this.deps.stopSession(chat.id);
      await this.deps.archive(chat.id);
      archived = true;
    }
    return { chatId: chat.id, title: chat.title, projectId: chat.projectId, interrupted, archived };
  }
}
