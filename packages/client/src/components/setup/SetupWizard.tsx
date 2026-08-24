/**
 * SetupWizard — what a brand-new Dispatch install opens onto.
 *
 * It replaced "nothing", and the nothing was expensive. A fresh install used to
 * boot straight into the app shell with a seeded example project ("Hivebreak")
 * pointing at one developer's home directory, so the first thing a new user saw
 * was somebody else's work, unreadable, with sub-apps that could not start. The
 * only setup that ever ran was a single auth prompt — which is the ONE thing on
 * this screen that's optional.
 *
 * Four steps, in the order that a thing depends on the thing before it:
 *
 *   1. **Auth** — optional, and asked first because it decides who the rest of
 *      the setup belongs to. "Keep it off" is an answer, not a skip.
 *   2. **GitHub CLI** — probed, never assumed. Dispatch's whole PR workflow
 *      shells out to `gh`, and until now the first evidence that it wasn't
 *      installed (or was logged in as the wrong account) arrived when a PR
 *      failed to open, hours later. Non-blocking: plenty of projects never open
 *      a PR.
 *   3. **Agent runtime** — BLOCKING, alone among the four. Every other gap
 *      degrades to a feature you don't have; no harness means no chat can ever
 *      run, so letting someone past this step would hand them an app whose one
 *      purpose fails silently.
 *   4. **First project** — the real `NewProjectView`, not a smaller copy of it.
 *      Setup ends by making something that exists rather than by asserting the
 *      setup is done.
 *
 * It is a full-page takeover with no dismiss. That is deliberate: an install
 * with no project and no runtime has nothing behind this screen worth showing,
 * and a dismissible wizard is one someone escapes on their first run and then
 * can never find again.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Cpu,
  FolderPlus,
  Github,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { AuthSessionResponse, GhCliStatus, HarnessKind } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { Field, InlineError, TextInput } from "../sidebar/Modal.js";
import { NewProjectView } from "../project/NewProjectView.js";
import { api, type HarnessInfo } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { authPost, useAuth } from "../../stores/auth.js";
import { useSetup } from "../../stores/setup.js";
import { startLiveApp } from "../../lib/live.js";

/* -------------------------------------------------------------------- steps */

const STEPS = [
  { id: "auth", label: "Protect", icon: <ShieldCheck /> },
  { id: "github", label: "GitHub", icon: <Github /> },
  { id: "harness", label: "Agent", icon: <Cpu /> },
  { id: "project", label: "Project", icon: <FolderPlus /> },
] as const;

type StepId = (typeof STEPS)[number]["id"];

/** The numbered rail across the top. Read-only — you advance with the buttons. */
function StepRail({ current }: { current: number }) {
  return (
    <ol className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span aria-hidden className="mx-1 h-px w-4 bg-line sm:w-6" />}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-accent-line bg-accent-ghost text-accent"
                  : done
                    ? "border-line bg-panel-2 text-secondary"
                    : "border-line bg-app text-faint",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span className="[&_svg]:size-3.5">{done ? <Check /> : step.icon}</span>
              <span className="hidden sm:inline">{step.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A centred step body. Step 4 opts out — it needs the whole window. */
function StepCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="cm-scroll min-h-0 flex-1 overflow-y-auto px-5 py-8">
      <div className="mx-auto w-full max-w-[560px]">
        <h1 className="text-xl font-semibold text-primary">{title}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
        <div className="mt-5 space-y-3">{children}</div>
        <div className="mt-6 flex flex-wrap items-center gap-2">{footer}</div>
      </div>
    </div>
  );
}

/**
 * A probe result, said in one line with a tone.
 *
 * `warn` and `bad` are different on purpose: "gh is not installed" is a warning
 * because Dispatch runs without it, while "no agent runtime" is a dead end. The
 * colour is the only thing carrying that distinction on a screen someone reads
 * in five seconds.
 */
function StatusLine({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "info";
  children: ReactNode;
}) {
  const icon =
    tone === "ok" ? (
      <Check />
    ) : tone === "bad" ? (
      <CircleAlert />
    ) : tone === "warn" ? (
      <TriangleAlert />
    ) : null;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm leading-relaxed [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
        // `success`, not `ok` — the palette's name for it (see index.css). An
        // invented token name is not a compile error in Tailwind, it is a class
        // that silently does nothing, which is how the "installed and
        // authenticated" box first shipped looking identical to a neutral one.
        tone === "ok" && "border-success-line bg-success-ghost text-success",
        tone === "warn" && "border-warn-line bg-warn-ghost text-warn",
        tone === "bad" && "border-danger-line bg-danger-ghost text-danger",
        tone === "info" && "border-line bg-inset text-secondary",
      )}
    >
      {icon}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A command to run in a terminal, click-to-select. */
function Cmd({ children }: { children: string }) {
  return (
    <code className="mt-1 block w-fit max-w-full select-all overflow-x-auto rounded border border-line bg-inset px-1.5 py-0.5 font-mono text-xs text-primary">
      {children}
    </code>
  );
}

/* --------------------------------------------------------------- step: auth */

/**
 * Authentication, offered rather than imposed.
 *
 * This is the old first-run overlay from `AuthGate`, moved here so the one
 * question a fresh install already asked is the first of four instead of a modal
 * that fires on top of an app you have not set up yet.
 */
function AuthStep({ onDone }: { onDone: () => void }) {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const [form, setForm] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [canonicalUrl, setCanonicalUrl] = useState(location.origin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function keepOff() {
    setBusy(true);
    setError(null);
    try {
      await authPost("/api/auth/first-run/dismiss");
      if (status) useAuth.getState().applyStatus({ ...status, firstRunDismissed: true });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await authPost<AuthSessionResponse>("/api/auth/bootstrap", {
        username,
        displayName,
        password,
        canonicalUrl,
      });
      useAuth.getState().applySession(session);
      const current = useAuth.getState().status;
      if (current) {
        useAuth.getState().applyStatus({
          ...current,
          enabled: true,
          configured: true,
          firstRunDismissed: true,
          user: session.user,
        });
      }
      // The socket has been up since boot on an auth-off install and
      // `startLiveApp` is idempotent — this only covers the case where it was
      // never started, so the rest of the wizard has live data either way.
      startLiveApp();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Already signed in — a reload mid-wizard on an install that enabled auth in
  // an earlier pass. There is nothing to ask, and offering to create a second
  // owner would be an invitation to a confusing failure.
  if (user) {
    return (
      <StepCard
        title="Protect Dispatch"
        description="Authentication is already configured on this install."
        footer={
          <Button size="md" variant="primary" rightIcon={<ArrowRight />} onClick={onDone}>
            Continue
          </Button>
        }
      >
        <StatusLine tone="ok">
          Signed in as <strong>{user.username}</strong>. Accounts, passkeys and active sessions are
          managed later in Settings.
        </StatusLine>
      </StepCard>
    );
  }

  if (!form) {
    return (
      <StepCard
        title="Protect Dispatch"
        description="Authentication is off by default. Turn it on now, or leave it off and configure it later in Settings."
        footer={
          <>
            <Button size="md" variant="primary" onClick={() => setForm(true)}>
              Set up authentication
            </Button>
            <Button size="md" onClick={() => void keepOff()} disabled={busy}>
              {busy ? "Please wait…" : "Keep authentication off"}
            </Button>
          </>
        }
      >
        <StatusLine tone="info">
          Enable login before exposing Dispatch beyond this machine. The first account becomes the
          owner; all accounts see the same chats and settings.
        </StatusLine>
        <InlineError message={error} />
      </StepCard>
    );
  }

  return (
    <StepCard
      title="Create the owner account"
      description="The first account owns this install. Passkeys and an authenticator can be added afterwards."
      footer={
        <>
          <Button size="md" leftIcon={<ArrowLeft />} onClick={() => setForm(false)}>
            Back
          </Button>
          <Button
            size="md"
            variant="primary"
            type="submit"
            form="cm-setup-auth"
            disabled={busy}
            rightIcon={busy ? <Spinner size={12} /> : <ArrowRight />}
          >
            Create owner &amp; enable
          </Button>
        </>
      }
    >
      <form id="cm-setup-auth" className="space-y-3" onSubmit={submit}>
        <Field label="Owner username" required>
          <TextInput
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Display name">
          <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Password" hint="12 characters minimum" required>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Canonical URL" hint="passkey origin" required>
          <TextInput value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} />
        </Field>
        <InlineError message={error} />
      </form>
    </StepCard>
  );
}

/* ------------------------------------------------------------- step: github */

/**
 * The install command for `gh` on this OS.
 *
 * A guess off the user agent, and a guess is right here: the cost of showing a
 * macOS user the winget line is that they read one wrong word, while the cost of
 * showing nobody anything is that "install gh" is a search away for everyone.
 */
function ghInstallCommand(): string {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "winget install --id GitHub.cli";
  if (/Mac OS X|Macintosh/i.test(ua)) return "brew install gh";
  return "sudo apt install gh    # or see cli.github.com";
}

function GithubStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<GhCliStatus | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.setup.github());
    } catch {
      setStatus({ installed: false, authenticated: false, error: "Could not reach the server." });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const ok = !!status?.installed && status.authenticated;

  return (
    <StepCard
      title="GitHub CLI"
      description="Dispatch drives pull requests through the gh CLI — opening them, watching checks, replying to review threads. Everything else works without it."
      footer={
        <>
          <Button size="md" leftIcon={<ArrowLeft />} onClick={onBack}>
            Back
          </Button>
          <Button
            size="md"
            leftIcon={checking ? <Spinner size={12} /> : <RefreshCw />}
            disabled={checking}
            onClick={() => void check()}
          >
            Re-check
          </Button>
          <Button size="md" variant="primary" rightIcon={<ArrowRight />} onClick={onDone}>
            {ok ? "Continue" : "Continue without it"}
          </Button>
        </>
      }
    >
      {checking && !status ? (
        <StatusLine tone="info">Checking for gh…</StatusLine>
      ) : ok ? (
        <StatusLine tone="ok">
          gh {status?.version ?? ""} is installed and authenticated as <strong>{status?.login}</strong>
          .
        </StatusLine>
      ) : !status?.installed ? (
        <StatusLine tone="warn">
          gh is not on this machine&apos;s PATH. Install it and press Re-check — nothing you have
          done here has to be redone.
          <Cmd>{ghInstallCommand()}</Cmd>
        </StatusLine>
      ) : (
        <StatusLine tone="warn">
          gh {status.version ?? ""} is installed but not logged in. Authenticate it and press
          Re-check.
          <Cmd>gh auth login</Cmd>
        </StatusLine>
      )}
      {status?.error && !ok && (
        <p className="break-words text-xs leading-relaxed text-faint">{status.error}</p>
      )}
      <p className="text-xs leading-relaxed text-faint">
        Whichever account gh is logged in as is the account Dispatch opens pull requests as.
      </p>
    </StepCard>
  );
}

/* ------------------------------------------------------------ step: harness */

const HARNESS_LABEL: Record<HarnessKind, string> = { claude: "Claude Code", codex: "Codex" };
const HARNESS_BLURB: Record<HarnessKind, string> = {
  claude: "Anthropic's agent CLI. Subagents, skills and the full MCP tool surface.",
  codex: "OpenAI's agent CLI, driven over its app-server protocol.",
};

/**
 * Version AND source, not just version.
 *
 * `source` is the fact worth showing on this screen and it is invisible
 * everywhere else. Claude Code resolves to whichever is NEWER of the binary you
 * keep updated and the one pinned inside the SDK (see server `runtime.ts`), and
 * a `bundled` answer is how "why is the newest model missing from the picker"
 * gets diagnosed months later. Saying it once, here, costs a word.
 */
function runtimeHint(runtime: HarnessInfo["runtime"]): string {
  if (!runtime.available) return "not installed";
  return [runtime.version, runtime.source].filter(Boolean).join(" · ");
}

function HarnessStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [harnesses, setHarnesses] = useState<HarnessInfo[] | null>(null);
  const [picked, setPicked] = useState<HarnessKind | null>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const [list, settings] = await Promise.all([
        api.harnesses.list(),
        // Only for the preselection below, and allowed to fail: not knowing the
        // saved default is a worse first guess, not a broken step.
        api.settings.get().catch(() => null),
      ]);
      setHarnesses(list);
      // Preselect: the default already saved, else the first runtime that can
      // actually run — so the common case (exactly one installed) is a single
      // click on Continue.
      //
      // Reading the saved value matters more than it looks. Continue WRITES the
      // selection, so a step that always preselected the first available runtime
      // would silently revert a deliberate choice every time you came back to it
      // — via the back arrow, or a reload mid-setup. Picking Codex and pressing
      // reload left the install on Claude.
      const saved = settings?.harness?.defaultHarness;
      const usable = (k: HarnessKind | undefined) =>
        k ? list.find((h) => h.kind === k && h.runtime.available)?.kind : undefined;
      setPicked((p) => p ?? usable(saved) ?? list.find((h) => h.runtime.available)?.kind ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHarnesses([]);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const available = (harnesses ?? []).filter((h) => h.runtime.available);

  async function save() {
    if (!picked) return;
    setSaving(true);
    setError(null);
    try {
      // Read-modify-write: PUT /api/settings is a full REPLACE, so sending only
      // the harness block would clear every other preference on the install.
      const current = await api.settings.get();
      await api.settings.update({
        ...current,
        harness: {
          ...current.harness,
          defaultHarness: picked,
          defaults: current.harness?.defaults ?? {},
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard
      title="Agent runtime"
      description="Chats run on an agent CLI installed on this machine. Pick the one new projects should default to — every project and every chat can override it later."
      footer={
        <>
          <Button size="md" leftIcon={<ArrowLeft />} onClick={onBack}>
            Back
          </Button>
          <Button
            size="md"
            leftIcon={checking ? <Spinner size={12} /> : <RefreshCw />}
            disabled={checking}
            onClick={() => void check()}
          >
            Re-check
          </Button>
          <Button
            size="md"
            variant="primary"
            rightIcon={saving ? <Spinner size={12} /> : <ArrowRight />}
            disabled={!picked || saving || checking}
            onClick={() => void save()}
          >
            Continue
          </Button>
        </>
      }
    >
      {checking && !harnesses ? (
        <StatusLine tone="info">Looking for installed agent runtimes…</StatusLine>
      ) : available.length === 0 ? (
        <StatusLine tone="bad">
          No agent runtime found. Dispatch cannot run a chat without one — install Claude Code, then
          press Re-check.
          <Cmd>npm install -g @anthropic-ai/claude-code</Cmd>
        </StatusLine>
      ) : null}

      {/* `grid-cols-1`, not a bare `grid`. Tailwind's `grid-cols-1` is
          `minmax(0, 1fr)`, while an implicit track is `auto` — sized by its
          item's MIN-CONTENT, which a runtime path is not: the Codex binary lives
          under `…/.vscode/extensions/openai.chatgpt-26.818.41509-win32-x64/…`,
          and with an auto track that one unbreakable string pushed both cards
          ~90px past the column everything else on the step lines up with, and
          the `truncate` on it never engaged. */}
      {/* A real radio GROUP, not a row of `aria-pressed` buttons. This is a
          one-of-N choice, which is what radios are, and it buys the arrow-key
          roving and the "2 of 2" announcement for free — where a button group
          would need both hand-written. It also keeps the no-raw-button ratchet
          honest (`ui/rawButtons.test.ts`) without spending a baseline bump on a
          control that was never a button in the first place.

          That ratchet greps the SOURCE TEXT, so the phrase above is spelled
          without angle brackets on purpose: written the obvious way, this
          comment counts as a raw button and fails the test it is explaining. */}
      <div role="radiogroup" aria-label="Default agent runtime" className="grid grid-cols-1 gap-2">
        {(harnesses ?? []).map((h) => {
          const usable = h.runtime.available;
          const selected = picked === h.kind;
          return (
            <label
              key={h.kind}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                selected
                  ? "border-accent-line bg-accent-ghost"
                  : "border-line bg-panel-2 hover:border-line-strong",
                usable ? "cursor-pointer" : "cursor-not-allowed opacity-45 hover:border-line",
              )}
            >
              <input
                type="radio"
                name="cm-setup-harness"
                className="peer sr-only"
                value={h.kind}
                checked={selected}
                disabled={!usable}
                onChange={() => setPicked(h.kind)}
              />
              {/* The radio's visible stand-in. `peer-focus-visible` rather than
                  a focus ring on the label: the input is `sr-only`, so keyboard
                  focus lands somewhere with no box of its own to outline. */}
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-app",
                  selected ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
                )}
              >
                {selected && <Check />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-primary">{HARNESS_LABEL[h.kind]}</span>
                  <span className="truncate text-2xs text-faint">{runtimeHint(h.runtime)}</span>
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                  {HARNESS_BLURB[h.kind]}
                </span>
                {usable && h.runtime.path && (
                  <span className="mt-1 block truncate font-mono text-2xs text-faint">
                    {h.runtime.path}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <InlineError message={error} />
    </StepCard>
  );
}

/* ------------------------------------------------------------------- wizard */

/**
 * Where to start.
 *
 * Step 1 is the only one whose answer is recorded before the wizard finishes —
 * `firstRunDismissed` is written the moment you answer it. So a reload partway
 * through setup resumes past it rather than asking the same question twice, and
 * the back arrow can still take you there if answering "off" was a mistake.
 * Every later step re-derives its state from a live probe, so there is nothing
 * to resume for those.
 */
function initialStep(): StepId {
  const status = useAuth.getState().status;
  return status?.firstRunDismissed || status?.enabled ? "github" : "auth";
}

export function SetupWizard() {
  const [step, setStep] = useState<StepId>(initialStep);
  const index = STEPS.findIndex((s) => s.id === step);
  const markComplete = useSetup((s) => s.markComplete);

  const finish = useCallback(async () => {
    // Tell the server BEFORE flipping the local flag. If the write fails the
    // wizard staying up is the correct outcome — the alternative is an install
    // that believes it is configured, drops you into the app, and puts the
    // wizard back on the next load with a project already created.
    await api.setup.complete();
    markComplete();
  }, [markComplete]);

  return (
    // IN FLOW, not `fixed`, and with no z-index — App renders this INSTEAD of
    // the shell rather than over it. Both halves of that matter: a positioned
    // overlay with a z-index would paint above `ConnectingScreen` and
    // `UpdatingScreen`, which are `fixed` at z-auto and live OUTSIDE the auth
    // gate precisely so a server you cannot reach gets diagnosed instead of
    // being hidden behind a form. A wizard is not a more specific answer than
    // "the server isn't running", and on a fresh install — no project, no
    // runtime, four steps that all call the API — it is the screen most likely
    // to be up when the server goes away.
    <div
      className="flex h-[100dvh] flex-col bg-app text-primary antialiased"
      aria-label="Set up Dispatch"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-3.5">
          <ShieldCheck />
        </span>
        <h2 className="shrink-0 text-sm font-semibold text-primary">Set up Dispatch</h2>
        <div className="ml-auto min-w-0">
          <StepRail current={index} />
        </div>
      </header>

      {step === "auth" ? (
        <AuthStep onDone={() => setStep("github")} />
      ) : step === "github" ? (
        <GithubStep onBack={() => setStep("auth")} onDone={() => setStep("harness")} />
      ) : step === "harness" ? (
        <HarnessStep onBack={() => setStep("github")} onDone={() => setStep("project")} />
      ) : (
        // The REAL project page, filling what is left of the window — not a
        // smaller copy of it. It carries its own two-column layout and its own
        // "Finish with AI" hand-off; setup only changes where "done" goes.
        <NewProjectView setup onBack={() => setStep("harness")} onDone={finish} />
      )}
    </div>
  );
}
