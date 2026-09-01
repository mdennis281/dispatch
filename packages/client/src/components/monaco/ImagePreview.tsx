/**
 * Shared inline image canvas for code and source-control previews.
 *
 * The source may be a data URL (the regular worktree viewer) or an object URL
 * fetched through the authenticated session (git snapshots). Keeping the
 * canvas here means both surfaces get the same transparency treatment and
 * sizing instead of source control inventing a second image viewer.
 */
export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center overflow-auto p-6"
      style={{
        // Transparency checkerboard. Token-driven so the squares stay one rung
        // off the surface behind them in both dark and light themes.
        backgroundImage:
          "linear-gradient(45deg,var(--p-panel-2) 25%,transparent 25%),linear-gradient(-45deg,var(--p-panel-2) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--p-panel-2) 75%),linear-gradient(-45deg,transparent 75%,var(--p-panel-2) 75%)",
        backgroundSize: "18px 18px",
        backgroundPosition: "0 0,0 9px,9px -9px,-9px 0",
      }}
    >
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full rounded-sm border border-line-strong bg-inset shadow-[var(--shadow-pop)]"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  );
}
