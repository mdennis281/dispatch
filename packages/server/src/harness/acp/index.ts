/**
 * The ACP harness — Dispatch's adapter for any agent speaking the Agent Client
 * Protocol, registered as the `goose` provider.
 *
 * WHY THE SEAM IS AT THE PROTOCOL, NOT THE CLI. Ollama is a model server, not an
 * agent runtime: it has no tool loop, no approvals, no sessions and no MCP, so a
 * native "Ollama harness" would mean building an agent from scratch inside
 * Dispatch. ACP is the opposite bet — around fifty agents already implement the
 * agent side (goose, OpenCode, Qwen Code, Gemini CLI, Cursor, Copilot,
 * OpenHands), so ONE adapter buys all of them, and local models arrive as a
 * configuration of the agent rather than as a second implementation.
 *
 * That is why the runtime-specific facts live in {@link AcpAgentSpec} rather
 * than being hard-coded: adding OpenCode later should be a second `PROVIDERS`
 * row and a second spec, not a second adapter.
 *
 * MODELS COME FROM OLLAMA, NOT FROM ACP. The protocol has no model-listing
 * method — the agent resolves its model from its own config. So `listModels`
 * asks the configured Ollama endpoint for `/api/tags`, which is the only place
 * an honest answer exists. When that endpoint is unreachable the picker falls
 * back to the static seed rather than erroring, on the same principle as the
 * other two harnesses: a stale list beats a broken picker.
 */
import { fallbackModels, type ModelOption } from "@dispatch/shared";
import type {
  Harness,
  HarnessAccount,
  HarnessCapabilities,
  HarnessLimits,
  HarnessRuntimeInfo,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTextRequest,
} from "../types.js";
import { gooseRuntime } from "./runtime.js";
import { AcpConnection } from "./rpc.js";
import { AcpSession } from "./session.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Cap on the model probe so an unreachable Ollama can't pin a request. */
const PROBE_TIMEOUT_MS = 8_000;

/** Where Ollama listens when nothing says otherwise. */
const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/**
 * The ACP capability profile. See {@link HarnessCapabilities} for each field.
 *
 * Four of these are false because the PROTOCOL lacks the concept, not because
 * the adapter is unfinished — see the header of `session.ts`.
 */
export const ACP_CAPABILITIES: HarnessCapabilities = {
  // `session/request_permission` is raised per tool call with the tool's id,
  // title and raw input — the same granularity as Claude's `canUseTool`, and
  // strictly better than Codex, which can only ask about command classes.
  toolPermissions: true,
  // No structured question channel exists in ACP.
  questions: false,
  subagents: false,
  skills: true,
  // No host-triggered compaction method.
  compaction: false,
  // `session/load` resumes; there is no fork-at-message.
  fork: false,
  // A local model has no account and no rolling rate limit.
  usageLimits: false,
  // The agent resolves its model at spawn; see AcpSession.setModel.
  liveModelSwitch: false,
  // `session/set_mode` works on a live session.
  livePermissionSwitch: true,
  // ACP carries no reasoning effort. Empty hides the control entirely.
  efforts: [],
  // The permission request BLOCKS the agent until answered, so a host-side
  // veto really does stop the call before it runs.
  preToolGuard: true,
  // `mcpCapabilities.http` is what lets Dispatch's own tools be served from
  // services/mcp/manager-http.ts — the same bridge the Codex adapter uses.
  managerTransport: "http",
};

/**
 * The runtime-specific facts about ONE ACP agent.
 *
 * Everything that differs between goose and the next agent we add lives here,
 * so `AcpHarness` itself stays protocol-only.
 */
export interface AcpAgentSpec {
  /** Provider id this agent is registered under. */
  kind: "goose";
  /** Argv that puts the binary into ACP-on-stdio mode. */
  args: string[];
  /** Resolve the binary. */
  runtime: () => HarnessRuntimeInfo;
  /** Env that points the agent at a provider and model. */
  env: (model: string | undefined) => Record<string, string>;
}

/** goose: `goose acp`, configured through `GOOSE_*` / `OLLAMA_HOST`. */
export const GOOSE_AGENT: AcpAgentSpec = {
  kind: "goose",
  args: ["acp"],
  runtime: gooseRuntime,
  env: (model) => ({
    GOOSE_PROVIDER: process.env.GOOSE_PROVIDER ?? "ollama",
    ...(model ? { GOOSE_MODEL: model } : {}),
    OLLAMA_HOST: ollamaHost(),
  }),
};

/** The Ollama endpoint in effect, normalised to an absolute origin. */
export function ollamaHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OLLAMA_HOST?.trim();
  if (!raw) return DEFAULT_OLLAMA_HOST;
  // Ollama's own convention allows a bare `host:port`, which is not a URL.
  return /^https?:\/\//.test(raw) ? raw.replace(/\/$/, "") : `http://${raw}`;
}

export interface AcpHarnessOpts {
  /** Injectable agent spec (tests, and the future second provider). */
  agent?: AcpAgentSpec;
  /** Injectable runtime resolution (tests). */
  runtime?: HarnessRuntimeInfo;
  /** Injectable connection factory (tests). */
  connect?: (opts: {
    exePath: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  }) => AcpConnection;
  /** Injectable model probe (tests). */
  fetchModels?: (origin: string) => Promise<ModelOption[] | null>;
  genId?: () => string;
  now?: () => number;
  onStderr?: (line: string) => void;
}

export class AcpHarness implements Harness {
  readonly kind: "goose";
  readonly capabilities = ACP_CAPABILITIES;

  private readonly opts: AcpHarnessOpts;
  private readonly agent: AcpAgentSpec;
  private readonly genId: () => string;
  private readonly now: () => number;

  private modelCache?: { at: number; models: ModelOption[] };
  private modelProbe?: Promise<ModelOption[] | null>;

  constructor(opts: AcpHarnessOpts = {}) {
    this.opts = opts;
    this.agent = opts.agent ?? GOOSE_AGENT;
    this.kind = this.agent.kind;
    this.genId = opts.genId ?? (() => Math.random().toString(36).slice(2, 11));
    this.now = opts.now ?? (() => Date.now());
  }

  runtime(): HarnessRuntimeInfo {
    return this.opts.runtime ?? this.agent.runtime();
  }

  async listModels(opts: { refresh?: boolean } = {}): Promise<ModelOption[]> {
    if (!opts.refresh && this.modelCache && this.now() - this.modelCache.at < CACHE_TTL_MS) {
      return this.modelCache.models;
    }
    this.modelProbe ??= this.probeModels().finally(() => {
      this.modelProbe = undefined;
    });
    const models = await this.modelProbe;
    // Never throw: a picker with a stale list beats a picker that errored.
    if (!models?.length) return this.modelCache?.models ?? fallbackModels(this.kind);
    this.modelCache = { at: this.now(), models };
    return models;
  }

  private async probeModels(): Promise<ModelOption[] | null> {
    const probe = this.opts.fetchModels ?? fetchOllamaModels;
    try {
      return await probe(ollamaHost());
    } catch {
      return null;
    }
  }

  /**
   * A local model has no account-level rate limit.
   *
   * Null rather than an empty {@link HarnessLimits}, because an object would
   * make the usage meter render an empty gauge instead of hiding.
   */
  async readLimits(_account?: HarnessAccount): Promise<HarnessLimits | null> {
    return null;
  }

  /**
   * A one-shot text request — chat titles.
   *
   * Goes straight to Ollama rather than through ACP. Opening a whole agent
   * session to name a chat would spawn a process, load skills and attach MCP
   * servers for one sentence; the model is right there and `/api/generate`
   * answers in one call. This is exactly the latitude the
   * {@link HarnessTextRequest} seam exists to give a provider.
   */
  async generateText(request: HarnessTextRequest): Promise<string> {
    const models = await this.listModels();
    // The cheap row, which `toModelOptions` marks as the smallest model on
    // disk. Falling through to `models[0]` only happens for a single-model box
    // or the static seed, where there is nothing cheaper to choose.
    const model = (models.find((m) => m.hint === "fast") ?? models[0])?.value;
    if (!model) throw new Error("no local model available to generate text");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const res = await fetch(`${ollamaHost()}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          stream: false,
          // A title is a completion, not a chat: no history, no tools, and a
          // hard cap so a chatty local model can't run long.
          options: { num_predict: 64 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const body = (await res.json()) as { response?: unknown };
      return typeof body.response === "string" ? body.response.trim() : "";
    } finally {
      clearTimeout(timer);
    }
  }

  createSession(spec: HarnessSessionSpec): HarnessSession {
    const rt = this.runtime();
    if (!rt.available || !rt.path) {
      throw new Error(
        "goose is not installed. Install the goose CLI, or set DISPATCH_GOOSE_PATH to its binary.",
      );
    }
    const connect =
      this.opts.connect ??
      ((o): AcpConnection => new AcpConnection({ ...o, onStderr: this.opts.onStderr }));
    const conn = connect({
      exePath: rt.path,
      args: this.agent.args,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: { ...this.agent.env(spec.model), ...(spec.account?.env ?? {}) },
    });
    return new AcpSession({ spec, conn, genId: this.genId });
  }
}

/* ------------------------------------------------------------ projections */

interface OllamaTag {
  name?: string;
  model?: string;
  /** On-disk size in bytes. */
  size?: number;
  details?: { parameter_size?: string; quantization_level?: string };
}

/**
 * Ollama `/api/tags` → the picker's rows.
 *
 * The id IS the label here: `qwen3-coder:30b` is what a user pulled and what
 * they will recognise, so prettifying it would only make the picker disagree
 * with `ollama list`. The parameter size and quantisation go in the
 * description, which is where a picker row has space for them.
 *
 * THE `fast` HINT IS LOAD-BEARING, not decoration. {@link AcpHarness.generateText}
 * picks the cheap model by it, and before this the hint was only ever set on
 * the STATIC seed — so with Ollama reachable (the normal case) nothing matched
 * and chat titles fell through to `models[0]`, i.e. whatever order `/api/tags`
 * happened to return. A box with a 70B pulled alongside a small model could
 * therefore spend the 70B on a one-line title.
 *
 * Smallest on disk is the proxy for cheapest. It is not a benchmark, but for
 * local GGUFs it tracks load time and tokens/sec closely enough to be the right
 * default, and it is the only cost signal `/api/tags` offers. Only applied when
 * there is more than one model, because labelling the sole option "fast" says
 * nothing.
 */
export function toModelOptions(tags: OllamaTag[]): ModelOption[] {
  const rows: { option: ModelOption; size: number }[] = [];
  for (const tag of tags) {
    const value = tag.name ?? tag.model;
    if (!value) continue;
    const params = tag.details?.parameter_size;
    const quant = tag.details?.quantization_level;
    const description = [params, quant].filter(Boolean).join(" · ");
    rows.push({
      option: { value, label: value, ...(description ? { description } : {}) },
      size: typeof tag.size === "number" ? tag.size : Number.POSITIVE_INFINITY,
    });
  }

  if (rows.length > 1) {
    let cheapest: { option: ModelOption; size: number } | undefined;
    for (const row of rows) {
      if (Number.isFinite(row.size) && (!cheapest || row.size < cheapest.size)) cheapest = row;
    }
    if (cheapest) cheapest.option.hint = "fast";
  }
  return rows.map((r) => r.option);
}

/** Ask Ollama what it has pulled. Returns null when it can't be reached. */
export async function fetchOllamaModels(origin: string): Promise<ModelOption[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(`${origin}/api/tags`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: OllamaTag[] };
    return toModelOptions(body.models ?? []);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
