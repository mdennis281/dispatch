/**
 * ReviewerSection — who reviews the PRs agents open in this project.
 *
 * This page exists because the reviewer is assembled from two things that live
 * in different places and fail in different ways, and neither is discoverable on
 * its own:
 *
 *   - the per-project POLICY, in the committed `.dispatch/project.yaml`;
 *   - the app-wide ACCOUNT and its token, in the config dir, because this half
 *     is a secret and the manifest is committed.
 *
 * So the panel's real job is not the toggles. It is to make the dedicated-account
 * path SET UP CORRECTLY, because that path has two failure modes that are both
 * invisible until the first PR: a token that does not authenticate, and an
 * account that authenticates fine but was never invited to the repository —
 * which GitHub rejects only at request time with "Reviews may only be requested
 * from collaborators". Hence the numbered steps and a check that actually asks
 * GitHub, rather than a token box and good luck.
 *
 * CONTROLLED for the policy half (it renders the caller's draft and reports
 * edits upward, so the owning view batches one Save into `project.yaml`), and
 * SELF-MANAGING for the credential half — that one is app-wide server state with
 * its own endpoints, and batching a secret behind the project's Save button
 * would make "did my token save?" depend on a button labelled something else.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Gauge,
  Loader2,
  ScanEye,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import {
  resolveWorkflow,
  type Effort,
  type ReviewerCheck,
  type ReviewerIdentity,
  type ReviewerStatus,
  type ReviewerVerify,
  type WorkflowConfig,
} from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { OptionCard, ToggleRow } from "../ui/ToggleRow.js";
import { cn } from "../../lib/cn.js";

interface IdentityOption {
  id: ReviewerIdentity;
  label: string;
  blurb: string;
  /** The consequences, shown on the selected card — same shape as the profile picker. */
  effects: string[];
}

const IDENTITIES: IdentityOption[] = [
  {
    id: "self",
    label: "Review as you",
    blurb: "Posts under your own GitHub login. Nothing to set up.",
    effects: [
      "Works immediately — uses the `gh` login this machine already has",
      "GitHub refuses a verdict on your own PR, so reviews land as comments",
      "Inline comments are still review threads, and still block the merge",
      "Nothing sits in GitHub's reviewer queue — Dispatch tracks the request itself",
    ],
  },
  {
    id: "dedicated",
    label: "Dedicated account",
    blurb: "A machine account with its own name and avatar on the PR.",
    effects: [
      "Appears in GitHub's reviewer dropdown, so requesting it IS the trigger",
      "Can genuinely request changes, not just comment",
      "Reviews are attributable — obvious at a glance who said what",
      "Needs one free GitHub account, invited to this repo with Read access",
    ],
  },
];

const ROUND_OPTIONS = [2, 3, 4, 6, 8, 12].map((n) => ({
  value: String(n),
  label: `${n} rounds`,
}));

export function ReviewerSection({
  value,
  onChange,
  projectId,
  repo,
  fromManifest,
  disabled,
}: {
  value: WorkflowConfig;
  onChange: (next: WorkflowConfig) => void;
  /** Lets the setup check ask GitHub whether the account can actually be requested here. */
  projectId?: string;
  /** `owner/name` when the view knows it — display only, for the setup steps. */
  repo?: string;
  fromManifest?: boolean;
  disabled?: boolean;
}) {
  const resolved = resolveWorkflow({ workflow: value }).pr.reviewAgent;
  const isReviewProfile = value.profile === "review";

  const patch = (p: Partial<NonNullable<NonNullable<WorkflowConfig["pr"]>["reviewAgent"]>>) =>
    onChange({
      ...value,
      pr: { ...value.pr, reviewAgent: { ...value.pr?.reviewAgent, ...p } },
    });

  return (
    <div className="space-y-4">
      {/* The reviewer is inert without a PR to review. Saying so here beats a
          panel of live-looking controls that quietly do nothing. */}
      {!isReviewProfile && (
        <div className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-ghost px-3 py-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <p className="text-2xs leading-snug text-secondary">
            This project&rsquo;s workflow is{" "}
            <span className="cm-mono">{value.profile}</span>, so nothing here opens a pull
            request and there is nothing to review. Set the workflow to{" "}
            <span className="font-medium">Review</span> first — these settings are saved either
            way, and take effect when it is.
          </p>
        </div>
      )}

      <div className="rounded-md border border-line bg-panel-2/40">
        <ToggleRow
          checked={resolved.enabled}
          onChange={(v) => patch({ enabled: v })}
          disabled={disabled}
          className="px-3 py-2.5"
          icon={<ScanEye />}
          title="Review PRs with a Dispatch agent"
          description={
            <>
              When a review is requested on a PR here, Dispatch spawns a chat that reads the
              diff and posts a real GitHub review — inline comments and all. Off means PRs wait
              for whoever <span className="cm-mono">workflow.pr.reviewers</span> names.
            </>
          }
        >
          <>
            <div className="grid grid-cols-2 gap-2 border-t border-line-soft p-2">
              {IDENTITIES.map((opt) => (
                <OptionCard
                  key={opt.id}
                  selected={resolved.identity === opt.id}
                  onSelect={() => patch({ identity: opt.id })}
                  disabled={disabled}
                  icon={<UserRound />}
                  label={opt.label}
                  blurb={opt.blurb}
                  effects={opt.effects}
                />
              ))}
            </div>

            {resolved.identity === "dedicated" && (
              <DedicatedAccount projectId={projectId} repo={repo} />
            )}

            <div className="space-y-2.5 border-t border-line-soft px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <label className="flex items-center gap-2">
                  <span className="text-2xs text-faint">Effort</span>
                  <Select
                    options={EFFORT_OPTIONS}
                    value={resolved.effort}
                    onChange={(v: Effort) => patch({ effort: v })}
                    leftIcon={<Gauge />}
                    width={170}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-2xs text-faint">Cap</span>
                  <Select
                    options={ROUND_OPTIONS}
                    value={String(resolved.maxRounds)}
                    onChange={(v) => patch({ maxRounds: Number(v) })}
                    width={150}
                  />
                </label>
              </div>
              <p className="text-2xs leading-snug text-faint">
                Reviewing well is a reading job, so it defaults to high effort. The cap bounds
                the fix-and-re-request cycle: a review is only spent on the code it read, so a
                push re-arms it — the cap is what stops a PR that never converges.
              </p>

              <ToggleRow
                checked={resolved.post}
                onChange={(v) => patch({ post: v })}
                disabled={disabled}
                className="border-t border-line-soft pt-2.5"
                title="Post to GitHub"
                description="Off is a dry run: the reviewer reports its findings in its own chat and touches nothing. The honest way to see what it says before trusting it on a real PR."
              />

              <div className="border-t border-line-soft pt-2.5">
                <div className="mb-1 text-xs font-medium text-secondary">
                  What to be strict about
                </div>
                <p className="mb-1.5 text-2xs leading-snug text-faint">
                  Optional. Appended to the reviewer&rsquo;s briefing — the things this repo
                  keeps getting wrong, and anything it should not waste a round on.
                </p>
                <textarea
                  value={value.pr?.reviewAgent?.instructions ?? ""}
                  onChange={(e) => patch({ instructions: e.target.value })}
                  rows={3}
                  disabled={disabled}
                  placeholder="e.g. be strict about anything spawning a subprocess or touching the shutdown path; skip the generated client types"
                  className={cn(
                    "w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2",
                    "text-xs leading-relaxed text-secondary placeholder:text-faint",
                    "focus:border-accent-line focus:outline-none disabled:opacity-60",
                  )}
                />
              </div>
            </div>
          </>
        </ToggleRow>
      </div>

      {fromManifest && (
        <p className="text-2xs leading-snug text-faint">
          Saving writes <span className="cm-mono">workflow.pr.reviewAgent</span> into this
          repo&rsquo;s <span className="cm-mono">.dispatch/project.yaml</span>. The account and
          its token are never written there — that file is committed.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the account */

/**
 * The dedicated account: set it up, prove it works, or take it away.
 *
 * Saves and verifies against its own endpoints rather than riding the project's
 * Save button — see the file docblock. The token is write-only: it goes up on a
 * PUT and nothing ever sends it back, so this component can show that an account
 * is configured but can never re-display its secret.
 */
function DedicatedAccount({ projectId, repo }: { projectId?: string; repo?: string }) {
  const [status, setStatus] = useState<ReviewerStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "verify" | "remove" | null>("load");
  const [verify, setVerify] = useState<ReviewerVerify | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy("load");
    try {
      setStatus(await api.reviewer.get());
    } catch {
      setStatus({ configured: false });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!token.trim()) return;
    setBusy("save");
    setError(null);
    try {
      const res = await api.reviewer.save({ token: token.trim(), projectId });
      setStatus(res);
      setVerify(res.verify);
      // Drop it from component state the moment it is stored. Nothing reads it
      // back, and a secret sitting in a React tree is a secret in a heap dump.
      setToken("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const recheck = async () => {
    setBusy("verify");
    setError(null);
    try {
      setVerify(await api.reviewer.verify({ projectId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await api.reviewer.remove();
      setStatus({ configured: false });
      setVerify(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 border-t border-line-soft px-3 py-2.5">
      {status?.configured ? (
        <div className="flex items-center gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <Check className="size-3.5 shrink-0 text-success" />
            <span className="truncate text-xs text-secondary">
              Reviewing as <span className="font-medium">{status.login}</span>
            </span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void recheck()}>
              {busy === "verify" ? <Spinner size={12} /> : "Check again"}
            </Button>
            <IconButton size="sm" tip="Remove this account" disabled={busy !== null} onClick={() => void remove()}>
              {busy === "remove" ? <Spinner size={12} /> : <Trash2 />}
            </IconButton>
          </span>
        </div>
      ) : (
        <SetupSteps repo={repo} />
      )}

      <div className="flex items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            status?.configured
              ? "Paste a new token to replace the current one"
              : "github_pat_… — the reviewer account's token"
          }
          className={cn(
            "min-w-0 flex-1 rounded-md border border-line bg-inset px-2.5 py-1.5",
            "cm-mono text-xs text-secondary placeholder:font-sans placeholder:text-faint",
            "focus:border-accent-line focus:outline-none disabled:opacity-60",
          )}
          disabled={busy !== null}
        />
        <Button
          size="sm"
          variant="default"
          disabled={busy !== null || !token.trim()}
          onClick={() => void save()}
        >
          {busy === "save" ? <Spinner size={12} /> : status?.configured ? "Replace" : "Save"}
        </Button>
      </div>
      <p className="text-2xs leading-snug text-faint">
        Stored beside this install&rsquo;s{" "}
        <span className="cm-mono">auth.json</span>, never in the repo, and shared by every
        project. It is checked against GitHub before it is saved, and never sent back to this
        page afterwards.
      </p>

      {error && (
        <div className="flex items-start gap-1.5 text-2xs leading-snug text-danger">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {verify && (
        <ul className="space-y-1 border-t border-line-soft pt-2">
          {verify.checks.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </ul>
      )}

      {busy === "load" && (
        <div className="flex items-center gap-1.5 text-2xs text-faint">
          <Loader2 className="size-3 animate-spin" /> Reading the stored account…
        </div>
      )}
    </div>
  );
}

/** One verification result. Colour carries the verdict; the sentence carries the fix. */
function CheckRow({ check }: { check: ReviewerCheck }) {
  const Icon = check.state === "pass" ? Check : check.state === "warn" ? TriangleAlert : X;
  return (
    <li className="flex items-start gap-1.5">
      <Icon
        className={cn(
          "mt-0.5 size-3 shrink-0",
          check.state === "pass" ? "text-success" : check.state === "warn" ? "text-warn" : "text-danger",
        )}
      />
      <span className="text-2xs leading-snug text-muted">{check.detail}</span>
    </li>
  );
}

/**
 * The four things you have to do on GitHub, in order.
 *
 * Written out rather than linked because every one of them is a place people get
 * it wrong in a way the app cannot fix afterwards: a classic token instead of a
 * fine-grained one, `Contents` instead of `Pull requests`, and — the one that
 * costs an afternoon — forgetting that the account has to be a collaborator at
 * all before GitHub will let it be requested.
 */
function SetupSteps({ repo }: { repo?: string }) {
  const steps: Array<[string, React.ReactNode]> = [
    [
      "Make the account",
      <>
        Sign up for a second, free GitHub account — GitHub explicitly allows one machine account
        per person for automation. Give it a name you will recognise on a PR, like{" "}
        <span className="cm-mono">dispatch-reviewer</span>.
      </>,
    ],
    [
      "Invite it to the repo",
      <>
        In {repo ? <span className="cm-mono">{repo}</span> : "this repository"} → Settings →
        Collaborators, invite that account with <span className="font-medium">Read</span> access,
        and accept the invite from the new account. Read is enough to be requested as a reviewer,
        and it means a leaked token still cannot push.
      </>,
    ],
    [
      "Make a fine-grained token",
      <>
        Signed in as the new account: Settings → Developer settings → Personal access tokens →
        Fine-grained. Scope it to this repository and grant exactly one permission —{" "}
        <span className="cm-mono">Pull requests: Read and write</span>. Nothing else is needed.
      </>,
    ],
    [
      "Paste it below",
      <>
        Dispatch checks it before storing: that it authenticates, that it is not your own
        account, and that it really is a collaborator here.
      </>,
    ],
  ];
  return (
    <ol className="space-y-1.5">
      {steps.map(([title, body], i) => (
        <li key={title} className="flex gap-2">
          <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border border-line text-2xs text-muted">
            {i + 1}
          </span>
          <span className="min-w-0">
            <span className="text-xs font-medium text-secondary">{title}</span>
            <span className="mt-0.5 block text-2xs leading-snug text-faint">{body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

