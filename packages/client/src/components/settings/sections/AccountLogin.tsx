import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, LogIn, RotateCcw, X } from "lucide-react";
import type { AccountLoginFlow, SubscriptionStatus } from "@dispatch/shared";
import { api } from "../../../lib/api.js";
import { useSubscriptions } from "../../../stores/subscriptions.js";
import { InlineError, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { Spinner } from "../../ui/Spinner.js";

/** How often a running sign-in is re-read. The CLI moves at human speed. */
const POLL_MS = 1500;

/**
 * "Log in" for one account, run by the provider's own CLI on the server.
 *
 * Before this the pane could only print `CLAUDE_CONFIG_DIR=<dir>` and tell the
 * user to go and run the login themselves — and in PowerShell that line, typed
 * the obvious way, sets nothing and logs the DEFAULT account in instead. Here
 * the server applies the account's env overlay, so the right directory is
 * signed in by construction.
 *
 * The sign-in page is a LINK rather than a popup: the URL only exists after the
 * CLI prints it, by which time the click that could have opened a window
 * without being blocked is long gone.
 */
export function AccountLogin({ status }: { status: SubscriptionStatus }) {
  const reload = useSubscriptions((s) => s.load);
  const [flow, setFlow] = useState<AccountLoginFlow | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = status.id;
  const wasRunning = useRef(false);

  // Pick up a sign-in already in flight — the pane is left and re-entered,
  // and the CLI on the server does not care.
  useEffect(() => {
    let live = true;
    api.subscriptions
      .login(id)
      .then(({ flow: f }) => live && f?.state === "running" && setFlow(f))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  const running = flow?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      api.subscriptions
        .login(id)
        // Unlike the mount read, `null` here is news: we thought one was
        // running and the server knows nothing of it — a restart killed the
        // CLI with it. Keeping the old state spun "Waiting…" forever.
        .then(({ flow: f }) => setFlow(f))
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, running]);

  // The moment it ends, re-read the account list: the server re-probed the
  // login on exit, so the badge can turn green without a manual refresh.
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      void reload();
    }
  }, [running, reload]);

  const act = useCallback(async (fn: () => Promise<AccountLoginFlow | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next) setFlow(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = () =>
    act(async () => {
      setCode("");
      return api.subscriptions.startLogin(id);
    });
  const cancel = () =>
    act(async () => {
      await api.subscriptions.cancelLogin(id);
      setFlow(null);
    });
  const submit = () =>
    act(async () => {
      const next = await api.subscriptions.submitLoginCode(id, code);
      setCode("");
      return next;
    });

  // The probe is what turns are refused on, so it wins over the file check —
  // but a directory that does not exist holds no login whatever a probe says.
  const loggedIn = status.dirExists && (status.login?.checked ? status.login.loggedIn : status.loggedIn);

  if (!flow || flow.state === "cancelled") {
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <Button
          variant={loggedIn ? "ghost" : "primary"}
          leftIcon={busy ? <Spinner size={12} /> : <LogIn />}
          disabled={busy}
          onClick={() => void start()}
        >
          {loggedIn ? "Log in again" : "Log in"}
        </Button>
        {error && <InlineError message={error} />}
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-line-soft bg-inset/60 p-2" data-testid="account-login">
      {flow.state === "running" && !flow.url && (
        <div className="flex items-center gap-2 text-2xs text-muted">
          <Spinner size={12} /> Starting the sign-in…
        </div>
      )}
      {flow.state === "running" && flow.url && (
        <>
          <a
            href={flow.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            <ExternalLink className="size-3.5" /> Open the sign-in page
          </a>
          {flow.userCode && (
            <p className="text-2xs text-muted">
              Enter this code there: <span className="cm-mono text-primary">{flow.userCode}</span>
            </p>
          )}
          {flow.hint && <p className="text-2xs leading-snug text-faint">{flow.hint}</p>}
          {flow.awaitingCode && (
            <>
              <p className="text-2xs leading-snug text-faint">
                A browser may also have opened on the machine Dispatch runs on — finishing there
                is enough. Otherwise, paste the code the page shows you:
              </p>
              <div className="flex items-center gap-2">
                <TextInput
                  mono
                  aria-label="Sign-in code"
                  placeholder="Paste code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && code.trim() && !busy) void submit();
                  }}
                  className="!h-7 min-w-0 flex-1"
                />
                <Button
                  variant="primary"
                  disabled={busy || !code.trim()}
                  onClick={() => {
                    if (code.trim() && !busy) void submit();
                  }}
                >
                  Submit
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {flow.state === "running" && (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-2xs text-faint">
            <Spinner size={10} /> Waiting for the sign-in to finish
          </span>
          <Button variant="ghost" className="ml-auto" leftIcon={<X />} disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      )}
      {flow.state === "succeeded" && (
        <div className="flex items-center gap-2 text-2xs text-success">
          <CheckCircle2 className="size-3.5" /> Signed in.
          <Button variant="ghost" className="ml-auto" onClick={() => setFlow(null)}>
            Done
          </Button>
        </div>
      )}
      {flow.state === "failed" && (
        <div className="space-y-1.5">
          <InlineError message={flow.error ?? "The sign-in did not finish."} />
          <Button variant="ghost" leftIcon={<RotateCcw />} disabled={busy} onClick={() => void start()}>
            Try again
          </Button>
        </div>
      )}
      {error && <InlineError message={error} />}
    </div>
  );
}
