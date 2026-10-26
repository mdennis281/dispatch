/**
 * CommitMessageService — one-shot AI commit messages for the Source Control UI.
 *
 * Same seam as TitleService: a stateless `Harness.generateText` request, so the
 * provider picks its own economical model and its own no-tools, no-history
 * posture. The seed is the STAGED diff — what is actually about to be
 * committed — plus the repo's recent subjects so the generated message matches
 * the house style (conventional-commit or not) instead of imposing one.
 *
 * WHICH provider: the app's default, on its default account. A commit message
 * belongs to no chat, so there is no chat provider to inherit. This used to be
 * a direct Agent SDK `query()` hard-wired to `claude-haiku-4-5`, which meant a
 * Codex-only or goose-only install could not draft one at all, and every
 * install spent Claude on it whatever its default was (#425).
 *
 * NO FALLBACK provider. When the default is unset, unregistered or not
 * installed, {@link CommitMessageService.availability} says so and the button
 * is disabled with that reason. Quietly drafting on some other provider would
 * spend a subscription the user did not pick.
 *
 * Unlike a chat title this is user-initiated and lands in an editable box, so a
 * failure is surfaced to the caller rather than swallowed: the button should
 * say why nothing came back.
 */
import {
  providerFor,
  subscriptionFor,
  type CommitMessageAvailability,
  type HarnessKind,
  type HarnessTextRequest,
  type SubscriptionSettings,
} from "@dispatch/shared";
import type { HarnessRegistry } from "../harness/index.js";
import type { GitService } from "./git.js";
import { accountOf } from "./subscriptions.js";

/** Max wall-clock for one generation before we give up. */
const TIMEOUT_MS = 45_000;

/** How much staged patch to show the model. */
const MAX_DIFF_CHARS = 18_000;

/** A subject and a short body; the hint lets a provider size its answer. */
const MAX_OUTPUT_TOKENS = 400;

/** What the commit-message seam needs to know about the settings. */
export type CommitSettings = SubscriptionSettings & {
  /** Possibly absent: there may be no app default provider at all. */
  harness?: SubscriptionSettings["harness"] & { defaultHarness?: HarnessKind | null };
};

/** Thrown by {@link CommitMessageService.generate} when no provider can draft. */
export class NoCommitProviderError extends Error {
  readonly code = "no_provider";
  constructor(reason: string) {
    super(reason);
    this.name = "NoCommitProviderError";
  }
}

/**
 * Stand-in for the provider's own `generateText`, called AFTER the provider is
 * resolved — so the E2E fake still exercises the real "is there a provider"
 * gate rather than bypassing it.
 */
export type CommitGenerateFn = (request: HarnessTextRequest, provider: HarnessKind) => Promise<string>;

export interface CommitMessageServiceOptions {
  git: GitService;
  harnesses: Pick<HarnessRegistry, "find">;
  settings: () => Promise<CommitSettings | null>;
  generateText?: CommitGenerateFn;
}

export class CommitMessageService {
  private readonly git: GitService;
  private readonly harnesses: Pick<HarnessRegistry, "find">;
  private readonly settings: () => Promise<CommitSettings | null>;
  private readonly generateText?: CommitGenerateFn;

  constructor(opts: CommitMessageServiceOptions) {
    this.git = opts.git;
    this.harnesses = opts.harnesses;
    this.settings = opts.settings;
    this.generateText = opts.generateText;
  }

  /** Whether the button can work, with the reason it can't. Never throws. */
  async availability(): Promise<CommitMessageAvailability> {
    return (await this.resolve()).availability;
  }

  /**
   * Generate a commit message from what's currently staged. Throws when nothing
   * is staged (the UI disables the button, but a race shouldn't produce a
   * message describing an empty change), and {@link NoCommitProviderError}
   * when there is no provider to ask.
   */
  async generate(
    repoPath: string,
    opts: { hint?: string } = {},
  ): Promise<string> {
    const { availability, settings } = await this.resolve();
    if (!availability.available) throw new NoCommitProviderError(availability.reason);
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

    const provider = availability.provider;
    const request: HarnessTextRequest = {
      prompt: commitPrompt(diff, recent, opts.hint),
      purpose: "commit-message",
      timeoutMs: TIMEOUT_MS,
      maxOutput: MAX_OUTPUT_TOKENS,
      // Spent on the provider's DEFAULT account, the one the user set for it.
      account: accountOf(subscriptionFor(settings, provider)),
    };
    const raw = this.generateText
      ? await this.generateText(request, provider)
      : await this.harnesses.find(provider)!.generateText(request);
    const message = sanitizeMessage(raw);
    if (!message) throw new Error("the model returned an empty message");
    return message;
  }

  private async resolve(): Promise<{ availability: CommitMessageAvailability; settings: CommitSettings | null }> {
    const settings = await this.settings().catch(() => null);
    const kind = settings?.harness?.defaultHarness ?? undefined;
    if (!kind) {
      return {
        settings,
        availability: { available: false, reason: "No default provider is set. Choose one in Settings → Chat." },
      };
    }
    const harness = this.harnesses.find(kind);
    const label = providerFor(kind).label;
    if (!harness) {
      return {
        settings,
        availability: { available: false, reason: `The default provider (${label}) isn't installed or enabled.` },
      };
    }
    if (!harness.runtime().available) {
      return {
        settings,
        availability: { available: false, reason: `The default provider (${label}) isn't available on this machine.` },
      };
    }
    return { settings, availability: { available: true, provider: kind, label } };
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

/**
 * Deterministic in-process stand-in gated by `DISPATCH_FAKE_SDK=1` (mirrors
 * `makeFakeTitleGenerator`) so E2E never spawns a runtime for a commit message.
 * Derives a subject from the first changed path in the diff.
 */
export function makeFakeCommitGenerator(): CommitGenerateFn {
  return async ({ prompt }) => {
    const file = /^\+\+\+ b\/(.+)$/m.exec(prompt)?.[1];
    return file ? `chore: update ${file}` : "chore: update staged changes";
  };
}
