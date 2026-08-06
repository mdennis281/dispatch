/**
 * CommitMessageService — one-shot AI commit messages for the Source Control UI.
 *
 * Same shape as TitleService (and for the same reasons): a single
 * `query()` on the cheapest model with `settingSources: []` + `maxTurns: 1`, so
 * it never loads repo settings/MCP and never becomes a real agent loop. The
 * seed is the STAGED diff — what is actually about to be committed — plus the
 * repo's recent subjects so the generated message matches the house style
 * (conventional-commit or not) instead of imposing one.
 *
 * Unlike a chat title this is user-initiated and lands in an editable box, so a
 * failure is surfaced to the caller rather than swallowed: the button should
 * say why nothing came back.
 *
 * The `query` fn is injectable so tests (and `DISPATCH_FAKE_SDK=1`) run without a
 * `claude` subprocess or the network.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { GitService } from "./git.js";
import { claudeExecutableOption } from "./runtime.js";

/** Cheapest model — a commit message never justifies Opus/Sonnet spend. */
export const COMMIT_MESSAGE_MODEL = "claude-haiku-4-5";

/** Max wall-clock for one generation before we give up. */
const TIMEOUT_MS = 45_000;

/** How much staged patch to show the model. */
const MAX_DIFF_CHARS = 18_000;

/** The subset of the SDK `query` signature this service calls (single-shot). */
export type CommitQueryFn = (params: {
  prompt: string;
  options?: Options;
}) => Query;

export interface CommitMessageServiceOptions {
  git: GitService;
  query?: CommitQueryFn;
}

export class CommitMessageService {
  private readonly git: GitService;
  private readonly query: CommitQueryFn;

  constructor(opts: CommitMessageServiceOptions) {
    this.git = opts.git;
    this.query =
      opts.query ??
      (process.env.DISPATCH_FAKE_SDK === "1"
        ? makeFakeCommitQuery()
        : (sdkQuery as unknown as CommitQueryFn));
  }

  /**
   * Generate a commit message from what's currently staged. Throws when nothing
   * is staged (the UI disables the button, but a race shouldn't produce a
   * message describing an empty change).
   */
  async generate(
    repoPath: string,
    opts: { hint?: string } = {},
  ): Promise<string> {
    const diff = await this.git.stagedDiff(repoPath, MAX_DIFF_CHARS);
    if (!diff.trim()) {
      throw new Error("nothing staged — stage some changes first");
    }
    // Recent subjects teach the model this repo's convention. Best-effort: a
    // brand-new repo simply gets no examples.
    const recent = await this.git
      .log(repoPath, { limit: 10 })
      .then((c) => c.map((x) => x.subject).filter(Boolean))
      .catch(() => [] as string[]);

    const raw = await this.runQuery(commitPrompt(diff, recent, opts.hint));
    const message = sanitizeMessage(raw);
    if (!message) throw new Error("the model returned an empty message");
    return message;
  }

  private async runQuery(prompt: string): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    const acc = { text: "", result: "" };
    try {
      const q = this.query({
        prompt,
        options: {
          model: COMMIT_MESSAGE_MODEL,
          settingSources: [],
          maxTurns: 1,
          abortController: abort,
          ...claudeExecutableOption(),
        },
      });
      for await (const msg of q) collectText(msg, acc);
    } finally {
      clearTimeout(timer);
    }
    return acc.text.trim() || acc.result.trim();
  }
}

/* --------------------------------------------------------------- helpers */

/** Build the one-shot prompt from the staged diff + the repo's recent style. */
export function commitPrompt(
  diff: string,
  recentSubjects: string[],
  hint?: string,
): string {
  const lines = [
    "Write a git commit message for the staged changes below.",
    "",
    "Rules:",
    "- First line: a concise subject under 72 characters, imperative mood.",
    "- Then, ONLY if the change needs explanation, a blank line and a short body",
    "  of 1-3 bullet points covering WHY, not a file-by-file restatement.",
    "- Match the style of the recent commits shown below (if they use",
    "  conventional-commit prefixes like `feat:`/`fix:`, use one too; if not, don't).",
    "- No preamble, no surrounding quotes, no markdown code fences.",
    "- Respond with ONLY the commit message.",
  ];
  if (hint?.trim()) {
    lines.push("", `The author adds this context: ${hint.trim().slice(0, 500)}`);
  }
  if (recentSubjects.length) {
    lines.push("", "Recent commit subjects in this repo:");
    for (const s of recentSubjects.slice(0, 10)) lines.push(`- ${s}`);
  }
  lines.push("", "Staged changes:", "", diff);
  return lines.join("\n");
}

/** Strip fences/quotes/preamble and normalize whitespace around the message. */
export function sanitizeMessage(raw: string): string {
  let t = (raw ?? "").replace(/\r/g, "").trim();
  if (!t) return "";
  // Unwrap a single fenced block (```/```text) if the model wrapped its answer.
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fenced) t = fenced[1]!.trim();
  // Drop a leading narration line ("Here's a commit message:").
  t = t.replace(/^(?:here(?:'s| is)[^\n]*:|commit message:)\s*\n+/i, "");
  const lines = t.split("\n");
  // Strip wrapping quotes on the subject when the whole thing is quoted.
  if (lines.length === 1) {
    lines[0] = lines[0]!.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  }
  // Collapse 3+ blank lines and trim trailing whitespace per line.
  return lines
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pull the assistant/result text out of a one-shot query stream. */
function collectText(msg: SDKMessage, acc: { text: string; result: string }): void {
  const m = msg as unknown as Record<string, unknown> & { type?: string };
  if (m.type === "assistant") {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          acc.text += String((b as { text?: unknown }).text ?? "");
        }
      }
    }
  } else if (m.type === "result" && typeof (m as { result?: unknown }).result === "string") {
    acc.result = (m as { result: string }).result;
  }
}

/**
 * Deterministic in-process stand-in gated by `DISPATCH_FAKE_SDK=1` (mirrors
 * `makeFakeTitleQuery`) so E2E never spawns a `claude` subprocess for a commit
 * message. Derives a subject from the first changed path in the diff.
 */
export function makeFakeCommitQuery(): CommitQueryFn {
  return ({ prompt }) => {
    const file = /^\+\+\+ b\/(.+)$/m.exec(prompt)?.[1];
    const text = file ? `chore: update ${file}` : "chore: update staged changes";
    async function* gen(): AsyncGenerator<unknown, void> {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
      };
      yield { type: "result", subtype: "success", is_error: false, result: text };
    }
    const g = gen() as unknown as Record<string, unknown>;
    g.interrupt = async () => {};
    g.setModel = async () => {};
    g.setPermissionMode = async () => {};
    g.setMaxThinkingTokens = async () => {};
    return g as unknown as Query;
  };
}
