import type { ReactNode } from "react";
import { AlertTriangle, Check, Copy, Download, RotateCw } from "lucide-react";
import type { ArtifactType } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";
import { IconButton } from "../ui/IconButton.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { CodeBlock } from "../chat/CodeBlock.js";
import { Markdown } from "../chat/Markdown.js";
import { ArtifactFrame } from "./ArtifactFrame.js";
import type { ArtifactDoc, View } from "./useArtifactDoc.js";

/*
 * The CONTENT of an artifact view, as opposed to its shell. Two shells use it:
 * ArtifactPane (beside the chat, with Expand / Open in window / Close) and
 * ArtifactWindow (a window of its own, whose toolbar is the title bar). Both
 * lay out the same controls and the same body; only the chrome around them
 * differs.
 */

/**
 * Past this, Source shows a plain, truncated listing. An 8 MB page with an
 * inlined engine would otherwise go through the highlighter whole and hang
 * the tab; Copy and Download still give the full text.
 */
const SOURCE_HIGHLIGHT_MAX = 200_000;

/**
 * Version picker, Preview/Source, Reload, Copy, Download — the controls every
 * view of an artifact has. `onPickVersion(null)` means "follow the newest".
 */
export function ArtifactControls({
  doc,
  onPickVersion,
}: {
  doc: ArtifactDoc;
  onPickVersion: (version: number | null) => void;
}) {
  const { data, type, newest } = doc;
  const versionOptions = (data?.meta.versions ?? [])
    .slice()
    .reverse()
    .map((v) => ({
      value: String(v.n),
      label: v.n === newest ? `v${v.n} · latest` : `v${v.n}`,
      hint: new Date(v.createdAt).toLocaleString(),
    }));

  return (
    <>
      {data && versionOptions.length > 1 && (
        <Select
          options={versionOptions}
          value={String(data.version)}
          onChange={(v) => {
            const n = Number(v);
            // Picking the newest goes back to FOLLOWING it, so the next edit
            // the agent makes shows up without picking again.
            onPickVersion(n === newest ? null : n);
          }}
          align="end"
          width={200}
          size="md"
        />
      )}
      {doc.previewable && (
        <SegmentedControl<View>
          segments={[
            { value: "preview", label: "Preview" },
            { value: "source", label: "Source" },
          ]}
          value={doc.view}
          onChange={doc.setView}
        />
      )}
      {(type === "html" || type === "svg") && doc.view === "preview" && (
        <IconButton tip="Reload" onClick={doc.reload} disabled={!data}>
          <RotateCw />
        </IconButton>
      )}
      <IconButton tip={doc.copied ? "Copied" : "Copy source"} onClick={() => void doc.copy()} disabled={!data}>
        {doc.copied ? <Check /> : <Copy />}
      </IconButton>
      <IconButton tip="Download" onClick={doc.download} disabled={!data}>
        <Download />
      </IconButton>
    </>
  );
}

/** The rendered artifact (or its source), plus the runtime-error banner under it. */
export function ArtifactBody({ doc }: { doc: ArtifactDoc }) {
  const { loaded, data, type, storage, bundle, view, chatId } = doc;
  return (
    <>
      <div className="relative min-h-0 flex-1">
        {(loaded.state === "loading" ||
          (data && !storage.ready && (data.meta.type === "html" || data.meta.type === "svg"))) &&
          bundle.state !== "loading" && (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          )}
        {data && view === "preview" && bundle.state === "loading" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6">
            <div className="h-1.5 w-56 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${bundle.total ? Math.min(100, (bundle.loaded / bundle.total) * 100) : 0}%` }}
              />
            </div>
            <p className="text-xs text-muted tabular-nums">
              Loading assets — {formatMb(bundle.loaded)} of {formatMb(bundle.total)}
            </p>
          </div>
        )}
        {data && view === "preview" && bundle.state === "error" && (
          <Notice tone="danger">The artifact&rsquo;s assets didn&rsquo;t load: {bundle.message}</Notice>
        )}
        {loaded.state === "expired" && (
          <Notice>
            This artifact expired
            {loaded.expiredAt ? ` on ${new Date(loaded.expiredAt).toLocaleDateString()}` : ""} and its content
            was deleted. Artifacts are kept for a number of days after their last edit — see Settings →
            Retention.
          </Notice>
        )}
        {loaded.state === "error" && <Notice tone="danger">{loaded.message}</Notice>}
        {data &&
          storage.ready &&
          view === "preview" &&
          (type === "html" || type === "svg") &&
          (bundle.state === "none" || bundle.state === "ready") && (
          <ArtifactFrame
            key={`${data.version}:${doc.reloadKey}`}
            type={type}
            content={data.content}
            title={data.meta.title}
            storage={storage.mirror.current}
            {...(bundle.state === "ready" ? { assets: bundle.assets } : {})}
            onError={doc.onFrameError}
            onStorage={storage.onWrite}
          />
        )}
        {data && view === "preview" && type === "markdown" && (
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-3xl px-5 py-4">
              <Markdown chatId={chatId}>{data.content}</Markdown>
            </div>
          </ScrollArea>
        )}
        {data && view === "source" && (
          <ScrollArea className="h-full">
            <div className="p-3">
              {data.content.length > SOURCE_HIGHLIGHT_MAX ? (
                <>
                  <p className="mb-2 text-xs text-muted">
                    Showing the first {SOURCE_HIGHLIGHT_MAX.toLocaleString()} of{" "}
                    {data.content.length.toLocaleString()} characters, unhighlighted — Copy or Download for all
                    of it.
                  </p>
                  <pre className="cm-mono whitespace-pre-wrap break-all text-xs text-secondary">
                    {data.content.slice(0, SOURCE_HIGHLIGHT_MAX)}
                  </pre>
                </>
              ) : (
                <CodeBlock
                  code={data.content}
                  language={sourceLanguage(data.meta.type, data.meta.language)}
                />
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {doc.frameErrors.length > 0 && view === "preview" && (
        <details className="shrink-0 border-t border-line bg-danger/5 px-3 py-1.5 text-xs">
          <summary className="flex cursor-pointer items-center gap-1.5 text-danger [&_svg]:size-3.5">
            <AlertTriangle />
            {doc.frameErrors.length} runtime {doc.frameErrors.length === 1 ? "error" : "errors"} — the agent
            sees these through artifact_read
          </summary>
          <ul className="mt-1 max-h-40 space-y-1 overflow-auto">
            {doc.frameErrors.map((e) => (
              <li key={e} className="cm-mono whitespace-pre-wrap break-words !text-2xs text-secondary">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function Notice({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className={cn("max-w-sm text-center text-sm text-muted", tone === "danger" && "text-danger")}>
        {children}
      </p>
    </div>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLanguage(type: ArtifactType, language?: string): string {
  if (type === "code") return (language ?? "text").toLowerCase();
  if (type === "markdown") return "markdown";
  return "markup";
}
