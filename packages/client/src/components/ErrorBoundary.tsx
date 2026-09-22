/**
 * What the app does when a render throws.
 *
 * Before this existed, the answer was: nothing, visibly. React unmounts the
 * WHOLE root when an error reaches it with no boundary in the way, so one bad
 * row in one transcript replaced the entire window with a black rectangle, and
 * the only trace was a "Minified React error #xxx" in a console nobody has open
 * on a phone. The reported symptom — "chats populate, then the screen goes
 * black, and clearing `cm:last-project` fixes it" — is that failure mode
 * exactly: the remembered project decides which chat auto-opens, hydrate fetches
 * that chat's transcript a beat after the sidebar fills, and whatever is in it
 * takes the app down with it. Forgetting the project just lands you elsewhere.
 *
 * So there are three sizes of boundary here, and the small ones matter most:
 *
 *   - {@link RowErrorBoundary} — one transcript row. The blast radius of a row
 *     the renderer can't handle should be that row, and the fallback NAMES it
 *     (row id + the error), which is the single most useful fact for fixing it.
 *   - {@link RegionErrorBoundary} — a whole surface (main area, sidebar). Keeps
 *     the rest of the shell alive and navigable, and resets itself when
 *     `resetKey` changes, so switching chat or view clears a stuck region
 *     without a reload.
 *   - {@link AppErrorBoundary} — last resort. A full screen showing the real
 *     error, stack and component stack, with Copy and a one-click "clear this
 *     browser's saved view state" — the manual `cm:last-project` fix, as a
 *     button, since that is what actually gets someone unstuck today.
 *
 * Nothing is hidden behind a friendly message. This is an open-source app whose
 * users are developers; the stack IS the useful part. Production builds ship
 * source maps (see vite.config.ts) so the frames in it carry real names.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, RotateCw, Trash2 } from "lucide-react";
import { Button } from "./ui/Button.js";
import { LAYER } from "../lib/layers.js";

const BUILD_VERSION = typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : "dev";

export interface CaughtError {
  error: Error;
  /** React's own "the tree looked like this" trace — often the only pointer to the culprit. */
  componentStack: string;
}

interface Props {
  children: ReactNode;
  /** Where this boundary sits, used in the console tag and the copied report. */
  scope: string;
  /** Changing this value clears the caught error — how a region recovers without a reload. */
  resetKey?: string | number | null;
  render: (caught: CaughtError, retry: () => void) => ReactNode;
}

interface State {
  caught: CaughtError | null;
  resetKey: string | number | null | undefined;
}

class Boundary extends Component<Props, State> {
  override state: State = { caught: null, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // A new `resetKey` (different chat, different view) is a fresh start: the
    // thing that threw is no longer what we are being asked to render.
    if (props.resetKey !== state.resetKey) return { caught: null, resetKey: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "";
    this.setState({ caught: { error, componentStack } });
    // Logged as well as rendered: the fallback can only be read by whoever is
    // looking at the screen, and a bug report is usually written later from a
    // console copy-paste.
    console.error(`[dispatch] render error in ${this.props.scope}`, error, componentStack);
  }

  override render(): ReactNode {
    const { caught } = this.state;
    if (!caught) return this.props.children;
    return this.props.render(caught, () => this.setState({ caught: null }));
  }
}

/** One line per fact, in the order someone triaging wants them. */
export function errorReport(scope: string, caught: CaughtError): string {
  return [
    `Dispatch client error (${scope})`,
    `build: ${BUILD_VERSION}`,
    `url: ${location.href}`,
    `ua: ${navigator.userAgent}`,
    "",
    caught.error.stack || `${caught.error.name}: ${caught.error.message}`,
    "",
    "Component stack:",
    caught.componentStack.trim() || "(none)",
  ].join("\n");
}

function copyReport(scope: string, caught: CaughtError): void {
  void navigator.clipboard?.writeText(errorReport(scope, caught)).catch(() => {});
}

/**
 * Forget every `cm:`-prefixed localStorage key — the remembered project, the
 * layout, the per-task prefs — and reload.
 *
 * Deliberately scoped to this app's own prefix and deliberately NOT touching
 * anything server-side: it throws away where you were looking, never a chat, a
 * project or a setting. This is the workaround people already apply by hand in
 * devtools, and it belongs on the screen that tells you you are stuck.
 */
function clearViewState(): void {
  try {
    const store = globalThis.localStorage;
    if (store) {
      for (const key of Object.keys(store)) if (key.startsWith("cm:")) store.removeItem(key);
    }
  } catch {
    /* blocked storage — the reload below is still worth doing */
  }
  location.reload();
}

/** The whole-window fallback: the error in full, and the two things that fix it. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary
      scope="app"
      render={(caught) => (
        <div
          style={{ zIndex: LAYER.shutdown }}
          className="fixed inset-0 flex flex-col items-center overflow-y-auto bg-app px-4 py-10 text-primary"
        >
          <span className="mb-3.5 flex size-12 items-center justify-center rounded-xl border border-line bg-panel-2 text-danger [&_svg]:size-5">
            <AlertTriangle />
          </span>
          <p className="text-lg font-medium">Dispatch hit a rendering error</p>
          <p className="mt-1 max-w-[520px] text-center text-sm leading-relaxed text-muted">
            The interface stopped, but nothing on the server was affected — your chats and
            projects are intact. Reload to try again; if it happens every time on the same
            project, clear this browser&rsquo;s saved view state so Dispatch opens elsewhere.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" leftIcon={<RotateCw />} onClick={() => location.reload()}>
              Reload
            </Button>
            <Button leftIcon={<Copy />} onClick={() => copyReport("app", caught)}>
              Copy error details
            </Button>
            <Button leftIcon={<Trash2 />} onClick={clearViewState}>
              Clear saved view state
            </Button>
          </div>
          <pre className="cm-mono mt-5 w-full max-w-[900px] overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-inset p-3 text-2xs leading-relaxed text-secondary">
            {errorReport("app", caught)}
          </pre>
          <p className="mt-3 text-xs text-faint">
            Paste that into an issue — it is the whole diagnosis.
          </p>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}

/**
 * A surface-sized fallback. The shell around it keeps working, so the user can
 * navigate away from whatever threw instead of reloading into it again.
 */
export function RegionErrorBoundary({
  children,
  scope,
  resetKey,
}: {
  children: ReactNode;
  scope: string;
  resetKey?: string | number | null;
}) {
  return (
    <Boundary
      scope={scope}
      resetKey={resetKey}
      render={(caught, retry) => (
        <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto bg-app p-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-lg border border-line bg-panel-2 text-danger [&_svg]:size-5">
            <AlertTriangle />
          </span>
          <div>
            <p className="text-base font-medium text-secondary">This panel failed to render</p>
            <p className="mt-0.5 text-xs text-muted">
              The rest of Dispatch is still working — switch chat or view, or retry.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" leftIcon={<RotateCw />} onClick={retry}>
              Retry
            </Button>
            <Button size="sm" leftIcon={<Copy />} onClick={() => copyReport(scope, caught)}>
              Copy error details
            </Button>
          </div>
          <pre className="cm-mono max-h-[40vh] w-full max-w-[720px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-inset p-3 text-left text-2xs leading-relaxed text-secondary">
            {errorReport(scope, caught)}
          </pre>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}

/**
 * One transcript row. Small on purpose: a row Dispatch cannot render becomes a
 * one-line marker in the transcript naming the row id, and the conversation
 * around it reads normally.
 */
export function RowErrorBoundary({ children, rowId }: { children: ReactNode; rowId: string }) {
  const scope = `row ${rowId}`;
  return (
    <Boundary
      scope={scope}
      resetKey={rowId}
      render={(caught) => (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-2xs text-muted">
          <span className="cm-mono text-danger">
            This message could not be rendered — {caught.error.name}: {caught.error.message}
          </span>
          <span className="cm-mono text-faint">row {rowId}</span>
          <Button size="sm" variant="link" onClick={() => copyReport(scope, caught)}>
            Copy details
          </Button>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}
