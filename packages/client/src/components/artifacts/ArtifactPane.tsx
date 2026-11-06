import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Maximize2,
  Minimize2,
  RotateCw,
  X,
} from "lucide-react";
import { latestArtifactVersion, type ArtifactContent, type ArtifactType } from "@dispatch/shared";
import { api, ApiError } from "../../lib/api.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { artifactKey, useArtifactView, type OpenArtifact } from "../../stores/artifacts.js";
import { IconButton } from "../ui/IconButton.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { CodeBlock } from "../chat/CodeBlock.js";
import { Markdown } from "../chat/Markdown.js";
import { ArtifactFrame } from "./ArtifactFrame.js";
import { artifactIcon } from "./artifactIcon.js";

type Loaded =
  | { state: "loading" }
  | { state: "ok"; data: ArtifactContent }
  | { state: "expired"; expiredAt?: number }
  | { state: "error"; message: string };

type View = "preview" | "source";

/** Types whose preview is something other than the source itself. */
const PREVIEWABLE: ReadonlySet<ArtifactType> = new Set(["html", "svg", "markdown"]);

/** How long to gather a burst of frame errors before sending them in one POST. */
const ERROR_FLUSH_MS = 600;

/**
 * The artifact pane: one artifact, one version at a time, previewed or as
 * source. Placement (beside the transcript at `lg`, over it below) is the
 * host's job — see {@link ArtifactPaneHost}.
 */
export function ArtifactPane({ open }: { open: OpenArtifact }) {
  const { chatId, id, version: pinned } = open;
  const latestSeen = useArtifactView((s) => s.latest[artifactKey(chatId, id)] ?? 0);
  const expanded = useArtifactView((s) => s.expanded);
  const setExpanded = useArtifactView((s) => s.setExpanded);
  const openArtifact = useArtifactView((s) => s.openArtifact);
  const close = useArtifactView((s) => s.close);

  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [view, setView] = useState<View>("preview");
  const [reloadKey, setReloadKey] = useState(0);
  const [frameErrors, setFrameErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  // Following "latest" means refetching whenever the transcript shows a newer
  // version; a pinned version never changes, so it is fetched once.
  const fetchKey = pinned ?? `latest@${latestSeen}`;
  useEffect(() => {
    let live = true;
    setLoaded((prev) => (prev.state === "ok" && prev.data.meta.id === id ? prev : { state: "loading" }));
    api.chats
      .artifact(chatId, id, pinned ?? undefined)
      .then((data) => live && setLoaded({ state: "ok", data }))
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 410) {
          const at = (err.detail as { expiredAt?: number } | undefined)?.expiredAt;
          setLoaded({ state: "expired", ...(typeof at === "number" ? { expiredAt: at } : {}) });
        } else {
          setLoaded({ state: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      live = false;
    };
  }, [chatId, id, pinned, fetchKey]);

  const data = loaded.state === "ok" ? loaded.data : null;
  const shownVersion = data?.version;
  const type = data?.meta.type;

  // The errors on screen are the ones the server already knew for this
  // version plus what the frame reports now — reset whenever the version or
  // the render changes, since a reload is a new chance to throw.
  useEffect(() => {
    setFrameErrors(data?.errors ?? []);
  }, [data, reloadKey]);

  // Batch the frame's reports to the server, so `artifact_read` can tell the
  // agent its page threw. Deduped per version: an error in an animation loop
  // fires sixty times a second and is one fact.
  //
  // Two dedupes, with different lifetimes. What the BANNER shows resets with
  // every render (the effect above), so an error that comes back after Reload
  // is shown again. What has been POSTED lives for the version: the server
  // already has it, and resending it on every reload says nothing new.
  const pending = useRef<string[]>([]);
  const posted = useRef<{ key: string; seen: Set<string> }>({ key: "", seen: new Set() });
  const flushTimer = useRef<number | undefined>(undefined);
  const onFrameError = useCallback(
    (message: string) => {
      if (shownVersion === undefined) return;
      setFrameErrors((prev) => (prev.includes(message) ? prev : [...prev, message]));
      const key = `${chatId}:${id}:${shownVersion}`;
      if (posted.current.key !== key) posted.current = { key, seen: new Set() };
      if (posted.current.seen.has(message)) return;
      posted.current.seen.add(message);
      pending.current.push(message);
      window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(() => {
        const batch = pending.current.splice(0);
        if (batch.length) void api.chats.artifactErrors(chatId, id, shownVersion, batch).catch(() => {});
      }, ERROR_FLUSH_MS);
    },
    [chatId, id, shownVersion],
  );
  useEffect(() => () => window.clearTimeout(flushTimer.current), []);

  const Icon = artifactIcon(type ?? "html");
  const previewable = type ? PREVIEWABLE.has(type) : false;
  const effectiveView: View = previewable ? view : "source";
  const newest = data ? latestArtifactVersion(data.meta) : 0;

  const versionOptions = (data?.meta.versions ?? [])
    .slice()
    .reverse()
    .map((v) => ({
      value: String(v.n),
      label: v.n === newest ? `v${v.n} · latest` : `v${v.n}`,
      hint: new Date(v.createdAt).toLocaleString(),
    }));

  const copy = async () => {
    if (!data) return;
    if (await copyToClipboard(data.content)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  const download = () => {
    if (!data) return;
    // `application/octet-stream`, not text/html: the blob URL belongs to THIS
    // origin, and a browser that decided to navigate to an html blob instead of
    // saving it would run the artifact unsandboxed, same-origin.
    const blob = new Blob([data.content], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(data.meta.title)}-v${data.version}.${extensionOf(data.meta.type, data.meta.language)}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <span className="flex size-6 shrink-0 items-center justify-center text-accent-hi [&_svg]:size-3.5">
          <Icon />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary" title={data?.meta.title}>
          {data?.meta.title ?? "Artifact"}
        </span>
        {data && versionOptions.length > 1 && (
          <Select
            options={versionOptions}
            value={String(data.version)}
            onChange={(v) => {
              const n = Number(v);
              // Picking the newest goes back to FOLLOWING it, so the next edit
              // the agent makes shows up without picking again.
              openArtifact(chatId, id, n === newest ? null : n);
            }}
            align="end"
            width={200}
            size="md"
          />
        )}
        {previewable && (
          <SegmentedControl<View>
            segments={[
              { value: "preview", label: "Preview" },
              { value: "source", label: "Source" },
            ]}
            value={effectiveView}
            onChange={setView}
          />
        )}
        {(type === "html" || type === "svg") && effectiveView === "preview" && (
          <IconButton tip="Reload" onClick={() => setReloadKey((k) => k + 1)} disabled={!data}>
            <RotateCw />
          </IconButton>
        )}
        <IconButton tip={copied ? "Copied" : "Copy source"} onClick={() => void copy()} disabled={!data}>
          {copied ? <Check /> : <Copy />}
        </IconButton>
        <IconButton tip="Download" onClick={download} disabled={!data}>
          <Download />
        </IconButton>
        <IconButton tip={expanded ? "Restore" : "Expand"} onClick={() => setExpanded(!expanded)} className="max-lg:hidden">
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton tip="Close" onClick={close}>
          <X />
        </IconButton>
      </div>

      <div className="relative min-h-0 flex-1">
        {loaded.state === "loading" && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
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
        {data && effectiveView === "preview" && (type === "html" || type === "svg") && (
          <ArtifactFrame
            key={`${data.version}:${reloadKey}`}
            type={type}
            content={data.content}
            title={data.meta.title}
            onError={onFrameError}
          />
        )}
        {data && effectiveView === "preview" && type === "markdown" && (
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-3xl px-5 py-4">
              <Markdown chatId={chatId}>{data.content}</Markdown>
            </div>
          </ScrollArea>
        )}
        {data && effectiveView === "source" && (
          <ScrollArea className="h-full">
            <div className="p-3">
              <CodeBlock
                code={data.content}
                language={sourceLanguage(data.meta.type, data.meta.language)}
              />
            </div>
          </ScrollArea>
        )}
      </div>

      {frameErrors.length > 0 && effectiveView === "preview" && (
        <details className="shrink-0 border-t border-line bg-danger/5 px-3 py-1.5 text-xs">
          <summary className="flex cursor-pointer items-center gap-1.5 text-danger [&_svg]:size-3.5">
            <AlertTriangle />
            {frameErrors.length} runtime {frameErrors.length === 1 ? "error" : "errors"} — the agent sees these
            through artifact_read
          </summary>
          <ul className="mt-1 max-h-40 space-y-1 overflow-auto">
            {frameErrors.map((e) => (
              <li key={e} className="cm-mono whitespace-pre-wrap break-words !text-2xs text-secondary">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className={cn("max-w-sm text-center text-sm text-muted", tone === "danger" && "text-danger")}>
        {children}
      </p>
    </div>
  );
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "artifact";
}

function extensionOf(type: ArtifactType, language?: string): string {
  if (type === "markdown") return "md";
  if (type === "code") return (language ?? "txt").toLowerCase().replace(/[^a-z0-9]/g, "") || "txt";
  return type;
}

function sourceLanguage(type: ArtifactType, language?: string): string {
  if (type === "code") return (language ?? "text").toLowerCase();
  if (type === "markdown") return "markdown";
  return "markup";
}

