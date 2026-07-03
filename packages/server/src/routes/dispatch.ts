/**
 * dispatchClientAction — the single inbound-action router.
 *
 * Every `WsClientAction` (from the WS socket) and the REST action endpoints
 * funnel through here so there is exactly one place mapping a wire action to the
 * right service call. It is deliberately socket-agnostic: it takes the action +
 * the service container, performs the side effect, and lets the services publish
 * their own bus events (which the WS layer fans back out). Failures are caught
 * and surfaced as an `error` bus event rather than throwing into the socket.
 *
 * The chat-creation + gh-action helpers are exported so the REST routes reuse
 * the exact same logic as the WS path.
 */
import { nanoid } from "nanoid";
import { resolve as resolvePath } from "node:path";
import type {
  WsClientAction,
  Chat,
  Project,
  Effort,
  ImageRef,
} from "@cm/shared";
import { COPILOT_LOGIN } from "../services/github.js";
import type { Services } from "../services/container.js";

/* ----------------------------------------------------------------- helpers */

function emitError(
  services: Services,
  message: string,
  detail?: string,
  chatId?: string,
): void {
  services.bus.publish({ type: "error", chatId, message, detail });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Input accepted by chat creation (WS `create-chat` + REST POST /api/chats). */
export interface CreateChatInput {
  projectId: string;
  title?: string;
  modeId?: string;
  agentId?: string;
  effort?: Effort;
}

/**
 * Create + persist a Chat, register a (lazy) broker session for it, and publish
 * `chat-update`. Mode/effort fall back to app settings / sane defaults.
 */
export async function createChat(
  services: Services,
  input: CreateChatInput,
): Promise<Chat> {
  const { store, bus } = services;
  const project = await store.getProject(input.projectId);
  if (!project) throw new Error(`project "${input.projectId}" not found`);

  const settings = await store.getSettings().catch(() => null);
  const now = Date.now();
  const chat: Chat = {
    id: nanoid(),
    projectId: input.projectId,
    title: input.title?.trim() || "New chat",
    modeId: input.modeId ?? settings?.defaultModeId ?? "default",
    agentId: input.agentId,
    effort: input.effort ?? "medium",
    worktrees: [],
    prs: [],
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
  const saved = await store.saveChat(chat);
  // The broker session is created lazily (see `ensureSession`) so its cwd binds
  // to the chat's worktree — which is often created AFTER the chat. Eagerly
  // creating it here bound the session to an empty `worktrees[]`, i.e. the main
  // checkout, defeating worktree isolation.
  bus.publish({ type: "chat-update", chat: saved });
  return saved;
}

/** Ensure the broker holds a live session for a chat (resume/create lazily). */
async function ensureSession(services: Services, chatId: string): Promise<Chat> {
  const { store, broker } = services;
  const chat = await store.getChat(chatId);
  if (!chat) throw new Error(`chat "${chatId}" not found`);
  if (!broker.has(chatId)) {
    const project = await store.getProject(chat.projectId).catch(() => null);
    const cwd = chat.worktrees[0];
    if (chat.sessionId) broker.resume(chat, project, cwd);
    else broker.create(chat, project, cwd);
  }
  return chat;
}

/** Resolve the project a gh/worktree action targets (by id, or via its chat). */
async function resolveProject(
  services: Services,
  a: { projectId?: string; chatId?: string },
): Promise<Project> {
  const { store } = services;
  if (a.projectId) {
    const p = await store.getProject(a.projectId);
    if (!p) throw new Error(`project "${a.projectId}" not found`);
    return p;
  }
  if (a.chatId) {
    const chat = await store.getChat(a.chatId);
    if (!chat) throw new Error(`chat "${a.chatId}" not found`);
    const p = await store.getProject(chat.projectId);
    if (!p) throw new Error(`project "${chat.projectId}" not found`);
    return p;
  }
  throw new Error("gh-action requires a projectId or chatId");
}

/** Best-effort: the branch of a chat's first worktree (for `ship`). */
async function chatBranch(
  services: Services,
  chat: Chat | null,
  project: Project,
): Promise<{ branch?: string; cwd?: string }> {
  const wtPath = chat?.worktrees[0];
  if (!wtPath) return {};
  try {
    const list = await services.worktrees.list(project);
    const found = list.find(
      (w) => resolvePath(w.path) === resolvePath(wtPath),
    );
    return { branch: found?.branch, cwd: wtPath };
  } catch {
    return { cwd: wtPath };
  }
}

/* --------------------------------------------------------------- gh-action */

type GhAction = Extract<WsClientAction, { type: "gh-action" }>;

/** Map a `gh-action` op to the GitHubService. Publishes pr/workflow/notice events. */
export async function runGhAction(
  services: Services,
  action: GhAction,
): Promise<void> {
  const { github, store } = services;
  const project = await resolveProject(services, action);
  const repo = await github.repoForProject(project);
  const ctx = { chatId: action.chatId };
  const needPr = (): number => {
    if (action.prNumber === undefined) {
      throw new Error(`gh-action "${action.op}" requires a prNumber`);
    }
    return action.prNumber;
  };

  switch (action.op) {
    case "ship": {
      const chat = action.chatId ? await store.getChat(action.chatId) : null;
      const { branch, cwd } = await chatBranch(services, chat, project);
      if (!branch) {
        throw new Error("ship requires a chat with a worktree branch");
      }
      await github.ship(project, branch, { cwd, chatId: action.chatId });
      return;
    }
    case "refresh":
      await github.refreshPr(repo, needPr(), ctx);
      return;
    case "merge":
      await github.merge(repo, needPr(), "squash", ctx);
      return;
    case "hold":
      await github.hold(repo, needPr(), true, ctx);
      return;
    case "unhold":
      await github.hold(repo, needPr(), false, ctx);
      return;
    case "label":
      if (!action.label) throw new Error("label op requires a label");
      await github.setLabel(repo, needPr(), action.label, true, ctx);
      return;
    case "unlabel":
      if (!action.label) throw new Error("unlabel op requires a label");
      await github.setLabel(repo, needPr(), action.label, false, ctx);
      return;
    case "rerun":
      await github.rerunFailedChecks(repo, needPr(), ctx);
      return;
    case "resolve-thread":
      if (!action.threadId) {
        throw new Error("resolve-thread op requires a threadId");
      }
      await github.resolveThread(action.threadId, ctx);
      return;
    case "review":
      await github.requestReview(repo, needPr(), COPILOT_LOGIN, ctx);
      return;
    case "dispatch": {
      if (!action.workflow) throw new Error("dispatch op requires a workflow");
      const ref = action.ref ?? project.defaultBranch ?? "main";
      await github.dispatch(repo, action.workflow, ref, action.inputs ?? {}, ctx);
      return;
    }
    default: {
      const _exhaustive: never = action.op;
      throw new Error(`unknown gh-action op ${String(_exhaustive)}`);
    }
  }
}

/* ---------------------------------------------------------------- dispatch */

/**
 * Route one inbound client action to the services. Never throws — any failure is
 * caught and published as an `error` event tagged with the action's chatId.
 */
export async function dispatchClientAction(
  services: Services,
  action: WsClientAction,
): Promise<void> {
  const { broker, worktrees, runner, store } = services;
  const chatId = "chatId" in action ? action.chatId : undefined;
  try {
    switch (action.type) {
      case "create-chat":
        await createChat(services, action);
        return;

      case "subscribe":
      case "unsubscribe":
        // Socket-scoped; the WS layer broadcasts every event, so these are
        // acknowledged no-ops at the service layer.
        return;

      case "send-message":
        await ensureSession(services, action.chatId);
        await broker.sendMessage(action.chatId, action.text ?? "", {
          priority: action.priority,
          images: action.images as ImageRef[] | undefined,
          effort: action.effort,
        });
        return;

      case "steer":
        await ensureSession(services, action.chatId);
        await broker.sendMessage(action.chatId, action.text, {
          priority: action.priority ?? "next",
        });
        return;

      case "answer-permission": {
        const ok = broker.resolvePermission(action.requestId, {
          decision: action.decision,
          updatedInput: action.updatedInput,
          message: action.message,
        });
        if (!ok) {
          emitError(
            services,
            "no pending permission for that request",
            action.requestId,
            action.chatId,
          );
        }
        return;
      }

      case "answer-question": {
        // AskUserQuestion rides the permission channel; the broker feeds the
        // chosen answer back to the model as the tool's ALLOW result (with the
        // answer merged into the tool input as `answers`), not a raw input swap.
        const ok = broker.answerQuestion(action.requestId, {
          optionId: action.optionId,
          answer: action.answer,
          answers: action.answers,
        });
        if (!ok) {
          emitError(
            services,
            "no pending question for that request",
            action.requestId,
            action.chatId,
          );
        }
        return;
      }

      case "set-mode":
        await ensureSession(services, action.chatId);
        await broker.setMode(action.chatId, action.modeId);
        return;

      case "set-effort":
        await ensureSession(services, action.chatId);
        await broker.setEffort(action.chatId, action.effort);
        return;

      case "set-agent":
        await ensureSession(services, action.chatId);
        await broker.setAgent(action.chatId, action.agentId);
        return;

      case "set-model":
        await ensureSession(services, action.chatId);
        await broker.setModel(action.chatId, action.model);
        return;

      case "regenerate-title":
        // Best-effort + async: don't block the socket on a title round-trip.
        void services.title.regenerate(action.chatId);
        return;

      case "set-title": {
        // Explicit rename: persist the new title on the chat record and fan out
        // `chat-update` so every connected client re-titles it in place.
        const chat = await store.getChat(action.chatId);
        if (!chat) throw new Error(`chat "${action.chatId}" not found`);
        const title = action.title.trim() || "Untitled chat";
        if (title === chat.title) return;
        const saved = await store.saveChat({ ...chat, title, updatedAt: Date.now() });
        services.bus.publish({ type: "chat-update", chat: saved });
        return;
      }

      case "interrupt":
        await broker.interrupt(action.chatId);
        return;

      case "rollback": {
        const cp = await store.getCheckpoint(action.chatId, action.messageId);
        if (!cp) {
          services.bus.publish({
            type: "notice",
            chatId: action.chatId,
            level: "warn",
            text: "No checkpoint recorded for that message — nothing to roll back.",
          });
          return;
        }
        const res = await services.checkpoints.rollback(
          action.chatId,
          action.messageId,
        );
        if (res.sessionMessageUuid) {
          await broker.fork(action.chatId, res.sessionMessageUuid);
        }
        services.bus.publish({
          type: "notice",
          chatId: action.chatId,
          level: "info",
          text: `Rolled back to ${action.messageId} (${res.removed.length} file(s) reverted).`,
        });
        return;
      }

      case "start-runner": {
        const project = await resolveProject(services, action);
        const subApp = project.subApps.find((s) => s.id === action.subAppId);
        if (!subApp) {
          throw new Error(
            `subApp "${action.subAppId}" not found on project "${project.id}"`,
          );
        }
        await runner.start(action.worktreePath, subApp, {
          projectId: project.id,
          chatId: action.chatId,
        });
        return;
      }

      case "stop-runner":
        await runner.stop(action.runnerId);
        return;

      case "create-worktree": {
        const project = await resolveProject(services, {
          projectId: action.projectId,
          chatId: action.chatId,
        });
        await worktrees.create(project, action.branch, { chatId: action.chatId });
        // If a session was already spun up (e.g. via set-mode/effort) before this
        // worktree existed, it is bound to the wrong cwd. Drop it while it is
        // still unstarted so it rebinds to the worktree on next use.
        if (action.chatId) {
          const sess = broker.getSession(action.chatId);
          if (sess?.started) {
            // A RUNNING SDK session is pinned to the cwd it launched in — the new
            // worktree can't retro-bind. Don't silently mislead the user: warn
            // them and point at the fix (fresh chat, worktree created first).
            services.bus.publish({
              type: "notice",
              chatId: action.chatId,
              level: "warn",
              text: "This chat is already running in its original directory, so the new worktree won't apply to it. Start a fresh chat (create the worktree first) for worktree-isolated work.",
            });
          } else if (sess) {
            await broker.stop(action.chatId);
          }
        }
        return;
      }

      case "remove-worktree":
        await worktrees.remove(action.worktreePath, { chatId: action.chatId });
        return;

      case "gh-action":
        await runGhAction(services, action);
        return;

      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown action ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    emitError(services, `action "${action.type}" failed`, errText(err), chatId);
  }
}
