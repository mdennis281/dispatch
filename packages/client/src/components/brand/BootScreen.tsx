/**
 * What stands in for the app while it is still booting, once the splash has
 * gone.
 *
 * The splash (lib/bootSplash.ts) is supposed to cover the whole boot, but it is
 * capped — it has to be, or a wedged server pins the tab behind a logo — and
 * there are boots it never covered at all: a PWA opened before its server was
 * up lifts the splash on "unreachable", and when the server arrives the socket
 * connects and the connecting screen stands down a full REST snapshot before
 * there is anything to show. Both used to uncover the bare shell: "No project",
 * "No chat selected", every panel empty and reading as a FINISHED answer, for
 * as long as the snapshot took — which on a loaded machine is a long while.
 *
 * So the in-between states render the same mark the splash does, and say so.
 * Replaces the bare grey "Starting Dispatch…" line `AuthGate` and `App` used to
 * hold, which was the right idea in the wrong clothes: a static line of text
 * reads as stuck, and it looked nothing like the screen that came before it.
 *
 * The caption waits. A healthy boot spends a beat here at most, and text that
 * flashes up and vanishes is noise; one still here after `CAPTION_DELAY_MS` is
 * a boot somebody is now watching, and that person should be told what it is
 * waiting for.
 */
import { useEffect, useState, type ReactNode } from "react";
import { BootMark } from "./BootMark.js";

const CAPTION_DELAY_MS = 1_500;

/**
 * `children` render under the caption with no delay — they are for a boot that
 * has something to SAY (a failure, a way through), not a boot that is merely
 * taking its time.
 */
export function BootScreen({
  caption = "Starting Dispatch…",
  children,
}: {
  caption?: string;
  children?: ReactNode;
}) {
  const [showCaption, setShowCaption] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShowCaption(true), CAPTION_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      aria-label={caption}
      className="flex h-dvh flex-col items-center justify-center gap-4 bg-app dp-safe-pad"
    >
      <BootMark />
      <p
        className={`text-sm text-muted transition-opacity duration-300 ${showCaption || children ? "opacity-100" : "opacity-0"}`}
      >
        {caption}
      </p>
      {children}
    </div>
  );
}
