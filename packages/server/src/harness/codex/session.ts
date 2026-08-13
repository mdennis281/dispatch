/**
 * One Codex thread, presented as a {@link HarnessSession}.
 *
 * LIFECYCLE. Nothing is spawned until the first `send`, matching the Claude
 * adapter — a queued chat must cost nothing. On that first send we open (or
 * resume, or fork) a thread, then start a turn. Later sends either start a new
 * turn (thread idle) or STEER the running one (`turn/steer`), which is Codex's
 * direct equivalent of pushing another message into the SDK's streaming input
 * channel mid-turn.
 *
 * ASKS. Codex asks the host things as JSON-RPC requests it will block on
 * forever if unanswered, which is a sharper failure mode than the SDK's
 * `canUseTool` promise: a dropped answer wedges the thread with no timeout. So
 * every inbound request is registered in {@link pendingAsks} the moment it
 * arrives and is answered exactly once — including on dispose, where anything
 * still open is declined rather than abandoned.
 *
 * THE GUARD. Dispatch's workflow guard wants to VETO a command before it runs.
 * Claude has a PreToolUse hook for that; Codex has no host-side pre-tool
 * callback, so the guard is enforced at two weaker points instead:
 *   1. at the approval prompt, where we auto-decline a violating command; and
 *   2. on `item/started`, where a command that was never submitted for approval
 *      (because the posture is `never`) is caught and the turn interrupted.
 * (2) races the command by definition — it may already be running. That is a
 * real, documented reduction versus Claude, surfaced as
 * `capabilities.preToolGuard === false` so the UI can say so rather than imply
 * a guarantee that isn't there.
 */
import type { Effort, PermissionMode, ImageRef } from "@dispatch/shared";
import type {
  HarnessEvent,
  HarnessInput,
  HarnessLimits,
  HarnessPermissionResolution,
  HarnessQuestionAnswer,
  HarnessSession,
  HarnessSessionSpec,
} from "../types.js";
import { CodexStreamDecoder, questionsOf } from "./stream.js";
import { toCodexPosture, toDeveloperInstructions, clampEffort } from "./options.js";
import type { CodexConnection, RpcFrame, ServerRequest } from "./rpc.js";

/** A server→client request we owe an answer to. */
interface PendingAsk {
  id: number | string;
  /** How to answer it, given a host decision. */
  answer: (allow: boolean, resolution?: HarnessPermissionResolution) => void;
  /** How to answer a question-shaped ask. */
  answerQuestions?: (answers: HarnessQuestionAnswer[]) => void;
}

function sandboxPolicy(sandbox: "read-only" | "workspace-write" | "danger-full-access") {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" as const };
  if (sandbox === "read-only") return { type: "readOnly" as const };
  return { type: "workspaceWrite" as const };
}

export interface CodexSessionOpts {
  spec: HarnessSessionSpec;
  conn: CodexConnection;
  /** Released when the session disposes, so the shared process can shut down. */
  release: () => void;
  genId: () => string;
  /** Per-model supported efforts, for clamping. */
  supportedEfforts?: (model: string | undefined) => string[];
  /** Latest account limits, merged into a usage-limit turn end. */
  limitsSnapshot?: () => HarnessLimits | null;
  /** Extra `config` overrides merged into thread/start (e.g. MCP servers). */
  threadConfig?: Record<string, unknown>;
}

export class CodexSession implements HarnessSession {
  private readonly spec: HarnessSessionSpec;
  private readonly conn: CodexConnection;
  private readonly release: () => void;
  private readonly genId: () => string;
  private readonly decoder: CodexStreamDecoder;
  private readonly opts: CodexSessionOpts;

  private threadId?: string;
  private turnId?: string;
  private started = false;
  private disposed = false;
  /** Messages queued before the thread exists / while one is being opened. */
  private outbox: HarnessInput[] = [];
  private unsubscribes: (() => void)[] = [];
  private readonly pendingAsks = new Map<string, PendingAsk>();

  /** Effort currently pinned for the thread. */
  private effort: Effort;
  private model?: string;

  /* ------------------------------------------------- the event stream */

  private readonly queue: HarnessEvent[] = [];
  private waiter?: () => void;
  private ended = false;

  constructor(opts: CodexSessionOpts) {
    this.opts = opts;
    this.spec = opts.spec;
    this.conn = opts.conn;
    this.release = opts.release;
    this.genId = opts.genId;
    this.effort = opts.spec.effort;
    this.model = opts.spec.model;
    this.decoder = new CodexStreamDecoder({ genId: opts.genId });

    opts.spec.abortSignal?.addEventListener("abort", () => void this.dispose(), { once: true });
  }

  get events(): AsyncIterable<HarnessEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<HarnessEvent> => ({
        next: async (): Promise<IteratorResult<HarnessEvent>> => {
          for (;;) {
            const next = this.queue.shift();
            if (next) return { value: next, done: false };
            if (this.ended) return { value: undefined as never, done: true };
            await new Promise<void>((resolve) => (this.waiter = resolve));
          }
        },
      }),
    };
  }

  private emit(...events: HarnessEvent[]): void {
    if (this.ended) return;
    this.queue.push(...events);
    this.waiter?.();
    this.waiter = undefined;
  }

  private end(): void {
    this.ended = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  /* --------------------------------------------------------- sending */

  send(input: HarnessInput): void {
    if (this.disposed) return;
    if (input.effort) this.effort = input.effort;
    this.outbox.push(input);
    if (!this.started) {
      this.started = true;
      void this.open().catch((err) => this.fail(err));
    } else {
      void this.flush().catch((err) => this.fail(err));
    }
  }

  pending(): number {
    return this.outbox.length;
  }

  /** Open (or resume/fork) the thread, then drain whatever is queued. */
  private async open(): Promise<void> {
    const posture = toCodexPosture(this.spec.permissionMode);
    const config = this.threadConfig();
    const base = {
      cwd: this.spec.cwd,
      approvalPolicy: posture.approvalPolicy,
      sandbox: posture.sandbox,
      model: this.model,
      developerInstructions: toDeveloperInstructions(this.spec.systemPromptAppends),
      ...(Object.keys(config).length ? { config } : {}),
    };

    let result: { thread?: { id?: string }; model?: string };
    if (this.spec.resumeSessionId && this.spec.fork) {
      result = await this.conn.call("thread/fork", {
        threadId: this.spec.resumeSessionId,
        ...(this.spec.forkAtId ? { lastTurnId: this.spec.forkAtId } : {}),
        ...base,
      });
    } else if (this.spec.resumeSessionId) {
      result = await this.conn.call("thread/resume", {
        threadId: this.spec.resumeSessionId,
        ...base,
      });
    } else {
      result = await this.conn.call("thread/start", base);
    }

    const id = result.thread?.id;
    if (!id) throw new Error("codex returned a thread with no id");
    this.threadId = id;
    this.model = result.model ?? this.model;

    this.unsubscribes.push(
      this.conn.onThread(id, (f) => this.onNotification(f)),
      this.conn.onRequest(id, (r) => this.onServerRequest(r)),
    );

    this.emit({
      type: "init",
      sessionId: id,
      model: this.model,
      permissionMode: this.spec.permissionMode,
    });

    await this.flush();
  }

  /** Send everything queued: start a turn, or steer the running one. */
  private async flush(): Promise<void> {
    if (!this.threadId || this.disposed) return;
    const batch = this.outbox;
    if (!batch.length) return;
    this.outbox = [];

    const input = batch.flatMap((m) => this.toUserInput(m));
    if (!input.length) return;

    if (this.turnId) {
      try {
        await this.conn.call("turn/steer", {
          threadId: this.threadId,
          input,
          expectedTurnId: this.turnId,
        });
        return;
      } catch {
        // The turn ended between our check and the call — fall through and open
        // a new one rather than dropping the user's message.
        this.turnId = undefined;
      }
    }

    const supported = this.opts.supportedEfforts?.(this.model) ?? [];
    const posture = toCodexPosture(this.spec.permissionMode);
    const res = await this.conn.call<{ turn?: { id?: string } }>("turn/start", {
      threadId: this.threadId,
      input,
      effort: clampEffort(this.effort, supported),
      model: this.model,
      approvalPolicy: posture.approvalPolicy,
      sandboxPolicy: sandboxPolicy(posture.sandbox),
    });
    this.turnId = res.turn?.id;
  }

  /** A Dispatch message → Codex `UserInput` blocks. */
  private toUserInput(msg: HarnessInput): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const img of msg.images ?? []) out.push(...this.imageInput(img));
    if (msg.text) out.push({ type: "text", text: msg.text, text_elements: [] });
    return out;
  }

  /** An attached image → a Codex input block. */
  private imageInput(img: ImageRef): Record<string, unknown>[] {
    if (!img.path) return [];
    // Remote/data URLs go as `image`; anything else is a path on this machine.
    return /^(https?:|data:)/.test(img.path)
      ? [{ type: "image", url: img.path }]
      : [{ type: "localImage", path: img.path }];
  }

  /* --------------------------------------------------- inbound stream */

  private onNotification(frame: RpcFrame): void {
    const events = this.decoder.decode(frame);

    // Track the active turn so steering and interrupt can name it.
    if (frame.method === "turn/started") {
      const turn = (frame.params as { turn?: { id?: string } } | undefined)?.turn;
      if (turn?.id) this.turnId = turn.id;
    }
    if (frame.method === "turn/completed") this.turnId = undefined;

    // The guard's second, weaker enforcement point — see the module header.
    if (frame.method === "item/started") this.guardStartedItem(frame);

    for (const e of events) {
      // A usage-limit turn end carries no reset time of its own; the account
      // snapshot has it, so merge before the scheduler sees it.
      if (e.type === "turn-end" && e.limit) {
        const snap = this.opts.limitsSnapshot?.();
        const resetsAt = snap?.primary?.resetsAt ?? snap?.secondary?.resetsAt;
        if (resetsAt) e.limit = { ...e.limit, resetsAt };
      }
      this.emit(e);
      if (e.type === "turn-end") this.turnId = undefined;
    }
  }

  /** Interrupt a command that started despite violating the workflow contract. */
  private guardStartedItem(frame: RpcFrame): void {
    const guard = this.spec.toolGuard;
    if (!guard) return;
    const item = (frame.params as { item?: Record<string, unknown> } | undefined)?.item;
    if (!item || item.type !== "commandExecution") return;
    const command = String(item.command ?? "");
    const reason = guard("Bash", { command });
    if (!reason) return;
    this.emit({ type: "notice", level: "warn", text: `Blocked: ${reason}` });
    void this.interrupt();
  }

  /* -------------------------------------------------- inbound requests */

  private onServerRequest(req: ServerRequest): void {
    switch (req.method) {
      case "item/commandExecution/requestApproval":
        return this.askPermission(req, "Bash", {
          command: String(req.params.command ?? ""),
          ...(typeof req.params.cwd === "string" ? { cwd: req.params.cwd } : {}),
        });

      case "item/fileChange/requestApproval":
        return this.askPermission(req, "Edit", {
          ...(typeof req.params.grantRoot === "string" ? { file_path: req.params.grantRoot } : {}),
        });

      case "item/permissions/requestApproval":
        return this.askPermissionEscalation(req);

      case "item/tool/requestUserInput":
        return this.askQuestions(req);

      case "mcpServer/elicitation/request":
        // An MCP server asking the user to fill a form. Dispatch has no surface
        // for arbitrary elicitation schemas yet, and leaving it unanswered would
        // wedge the thread, so decline explicitly.
        this.conn.respond(req.id, { action: "decline" });
        return;

      default:
        // Anything we don't model still needs an answer or the agent blocks.
        this.conn.respond(req.id, {});
    }
  }

  /** Surface an approval as a permission card. */
  private askPermission(req: ServerRequest, toolName: string, input: Record<string, unknown>): void {
    // The guard's first (and reliable) enforcement point.
    const denial = this.spec.toolGuard?.(toolName, input);
    if (denial) {
      this.conn.respond(req.id, { decision: "decline" });
      this.emit({ type: "notice", level: "warn", text: `Blocked: ${denial}` });
      return;
    }

    const requestId = this.genId();
    this.pendingAsks.set(requestId, {
      id: req.id,
      answer: (allow) => this.conn.respond(req.id, { decision: allow ? "accept" : "decline" }),
    });
    this.emit({
      type: "permission-request",
      requestId,
      toolName,
      input,
      reason: typeof req.params.reason === "string" ? req.params.reason : undefined,
      target: typeof input.command === "string" ? input.command : (input.file_path as string | undefined),
    });
  }

  /**
   * A request to widen the sandbox (extra write roots, network access).
   *
   * Codex's response has no "decline" variant — it expects a granted profile —
   * so a denial is expressed as an RPC error, which Codex treats as refusal.
   */
  private askPermissionEscalation(req: ServerRequest): void {
    const requestId = this.genId();
    const requested = req.params.permissions;
    this.pendingAsks.set(requestId, {
      id: req.id,
      answer: (allow) => {
        if (allow) this.conn.respond(req.id, { permissions: requested, scope: "session" });
        else this.conn.respondError(req.id, "denied by Dispatch");
      },
    });
    this.emit({
      type: "permission-request",
      requestId,
      toolName: "Permissions",
      input: (requested ?? {}) as Record<string, unknown>,
      reason: typeof req.params.reason === "string" ? req.params.reason : "Codex is requesting wider access.",
    });
  }

  /** Surface `requestUserInput` as a question card. */
  private askQuestions(req: ServerRequest): void {
    const questions = questionsOf(req.params);
    const requestId = this.genId();
    this.pendingAsks.set(requestId, {
      id: req.id,
      answer: (_allow) => this.conn.respond(req.id, { answers: {} }),
      answerQuestions: (answers) => {
        const payload: Record<string, { answers: string[] }> = {};
        for (const a of answers) payload[a.questionId] = { answers: a.selected };
        // Anything the human skipped still needs a key, or Codex waits on it.
        for (const q of questions) payload[q.id] ??= { answers: [] };
        this.conn.respond(req.id, { answers: payload });
      },
    });
    this.emit({ type: "question-request", requestId, questions });
  }

  resolvePermission(requestId: string, resolution: HarnessPermissionResolution): void {
    const ask = this.pendingAsks.get(requestId);
    if (!ask) return;
    this.pendingAsks.delete(requestId);
    ask.answer(resolution.decision === "allow", resolution);
  }

  resolveQuestion(requestId: string, answers: HarnessQuestionAnswer[]): void {
    const ask = this.pendingAsks.get(requestId);
    if (!ask) return;
    this.pendingAsks.delete(requestId);
    if (ask.answerQuestions) ask.answerQuestions(answers);
    else ask.answer(true);
  }

  /* --------------------------------------------------------- control */

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    try {
      await this.conn.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // Already finished — nothing to interrupt.
    }
  }

  /**
   * Codex applies posture per-turn rather than exposing a live setter, so this
   * records the new mode and lets the next `turn/start` carry it. A change made
   * mid-turn therefore takes effect on the following turn, which is the same
   * observable behaviour the SDK gives for a mode change during a tool call.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    (this.spec as { permissionMode: PermissionMode }).permissionMode = mode;
    if (!this.threadId) return;
    const posture = toCodexPosture(mode);
    try {
      await this.conn.call("thread/settings/update", {
        threadId: this.threadId,
        approvalPolicy: posture.approvalPolicy,
        sandboxPolicy: sandboxPolicy(posture.sandbox),
      });
    } catch {
      // Older app servers don't accept posture here; the next turn carries it.
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    if (this.threadId) {
      await this.conn.call("thread/settings/update", { threadId: this.threadId, model });
    }
  }

  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
    if (this.threadId) {
      const supported = this.opts.supportedEfforts?.(this.model) ?? [];
      await this.conn.call("thread/settings/update", {
        threadId: this.threadId,
        effort: clampEffort(effort, supported),
      });
    }
  }

  async compact(): Promise<void> {
    if (!this.threadId) return;
    await this.conn.call("thread/compact/start", { threadId: this.threadId });
  }

  async contextWindow(): Promise<number | undefined> {
    return this.decoder.contextWindow;
  }

  /** Translate Dispatch MCP/config vocabulary to Codex's config.toml keys. */
  private threadConfig(): Record<string, unknown> {
    const configured = { ...(this.opts.threadConfig ?? {}) };
    const servers: Record<string, Record<string, unknown>> = {};
    for (const [name, raw] of Object.entries(this.spec.mcpServers)) {
      if (raw.url) {
        servers[name] = {
          url: raw.url,
          ...(raw.headers ? { http_headers: raw.headers } : {}),
        };
      } else if (raw.command) {
        servers[name] = {
          command: raw.command,
          ...(raw.args ? { args: raw.args } : {}),
          ...(raw.cwd ? { cwd: raw.cwd } : {}),
          ...(raw.env ? { env: raw.env } : {}),
        };
      }
    }
    if (this.spec.managerMcp?.transport === "http") {
      servers.manager = {
        url: this.spec.managerMcp.url,
        http_headers: { Authorization: `Bearer ${this.spec.managerMcp.token}` },
      };
    }
    if (Object.keys(servers).length) {
      configured.mcp_servers = {
        ...((configured.mcp_servers as Record<string, unknown> | undefined) ?? {}),
        ...servers,
      };
    }
    if (this.spec.autoCompact !== false && this.spec.contextTokenLimit) {
      configured.model_auto_compact_token_limit = this.spec.contextTokenLimit;
    }
    return configured;
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit({ type: "turn-end", ok: false, subtype: "error", result: message });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Never abandon an ask — a thread blocked on an unanswered request would
    // survive this session and hold a slot in the shared process.
    for (const [, ask] of this.pendingAsks) {
      try {
        ask.answer(false);
      } catch {
        /* connection already gone */
      }
    }
    this.pendingAsks.clear();
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    if (this.threadId) {
      try {
        await this.conn.call("thread/unsubscribe", { threadId: this.threadId });
      } catch {
        /* process may already be down */
      }
    }
    this.end();
    this.release();
  }
}
