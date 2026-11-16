/**
 * Settings → Browser storage: what THIS browser keeps for THIS origin.
 *
 * Every other section here edits something the server stores, so it reads the
 * same from any device. This one does not. The stable install (4318), a dev
 * server (4319) and a phone are separate origins with separate storage, and
 * the figures below are only ever this one's — which is why the section opens
 * by naming the origin it is describing. Without that, "artifact cache: 0 B"
 * on a phone reads as the desktop's cache having vanished.
 *
 * The two cache LIMITS are the exception: they are server settings (one value,
 * every device), edited through the page's draft and Save bar like Retention.
 * They live here rather than in Retention because the question they answer is
 * "how much of this device may the cache take", and the only place that
 * question can be answered sensibly is beside the meter showing how much it
 * takes now and how much the origin has to give. In Retention they would be two
 * numbers next to deletion windows they have nothing to do with — the cache
 * never deletes anything on the server.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Eraser, HardDrive, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import {
  ARTIFACT_CACHE_MB_CEILING,
  ARTIFACT_PRELOAD_MB_CEILING,
  DEFAULT_ARTIFACT_CACHE_MB,
  DEFAULT_ARTIFACT_PRELOAD_MB,
} from "@dispatch/shared";
import {
  artifactCacheLimits,
  clear as clearArtifactCache,
  enforceArtifactCacheLimits,
  usage as artifactCacheUsage,
  type ArtifactCacheUsage,
} from "../../../lib/artifactCache.js";
import {
  deleteCache,
  listIdbDatabases,
  originEstimate,
  requestPersist,
  storagePersisted,
  surveyCaches,
  surveyLocalStorage,
  surveySessionStorage,
  usageDetailLabel,
  type CacheSurvey,
  type IdbDatabase,
  type OriginEstimate,
  type WebStorageSurvey,
} from "../../../lib/browserStorage.js";
import { bytes, numberField } from "../../../lib/format.js";
import { useChats } from "../../../stores/chats.js";
import { useConfig } from "../../../stores/config.js";
import { useProjects } from "../../../stores/projects.js";
import { useSettings } from "../../../stores/settings.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { IconButton } from "../../ui/IconButton.js";
import { SectionLabel } from "../../ui/Panel.js";
import { SplitBar, SplitDot } from "../../ui/SplitBar.js";
import { Spinner } from "../../ui/Spinner.js";
import { Field, TextInput } from "../../sidebar/Modal.js";
import type { AppPaneProps } from "./types.js";

interface Survey {
  estimate: OriginEstimate | null;
  persisted: boolean | null;
  cache: ArtifactCacheUsage;
  local: WebStorageSurvey;
  session: WebStorageSurvey;
  caches: CacheSurvey[] | null;
  idb: IdbDatabase[] | null;
}

/** How many localStorage keys to list before folding the rest into one line. */
const KEYS_SHOWN = 8;

const pctOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * `pane` is null while the settings draft has not loaded (or failed to): the
 * survey of this device needs nothing from the server, so it renders anyway
 * and only the limit fields wait.
 */
export function BrowserStorageSection({ pane }: { pane: AppPaneProps | null }) {
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [persistAsked, setPersistAsked] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    const [estimate, persisted, cache, caches, idb] = await Promise.all([
      originEstimate(),
      storagePersisted(),
      artifactCacheUsage(),
      surveyCaches(),
      listIdbDatabases(),
    ]);
    // Ask for every listed project's config now, so the per-project cap below
    // can show a project override. `artifactCacheLimits` triggers the lazy
    // load as a side effect; doing it here keeps that out of render.
    for (const p of cache.projects) artifactCacheLimits(p.projectId);
    setSurvey({
      estimate,
      persisted,
      cache,
      local: surveyLocalStorage(),
      session: surveySessionStorage(),
      caches,
      idb,
    });
  }, []);

  // Re-survey after a Save, and only once the eviction it implies has run.
  // The save bar fires `enforceArtifactCacheLimits` without awaiting it, so
  // re-measuring straight off the settings change raced it and showed
  // "19 MB of 10 MB" for a cache that was already at 9. Running it twice is
  // harmless — it reads only the small index rows, and a second pass over a
  // cache already within budget deletes nothing.
  const appRetention = useSettings((s) => s.app.retention);
  useEffect(() => {
    void enforceArtifactCacheLimits().finally(() => void refresh());
  }, [refresh, appRetention]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await fn();
      } finally {
        await refresh();
        setBusy(null);
      }
    },
    [refresh],
  );

  const projects = useProjects((s) => s.projects);
  const chats = useChats((s) => s.byId);
  // Subscribed so a project override that arrives after the first paint
  // re-renders the per-project caps; the value itself is read through
  // `artifactCacheLimits`, which is the cache's own reading of the layers.
  useConfig((s) => s.byProject);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const limits = artifactCacheLimits();
  const origin = typeof location !== "undefined" ? location.origin : "";

  if (!survey) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
        <Spinner size={14} /> Reading this browser&apos;s storage…
      </div>
    );
  }

  const { estimate, cache } = survey;

  return (
    <div className="space-y-4" data-testid="browser-storage">
      {/* ------------------------------------------------------- whose storage */}
      <div className="flex items-start gap-2 rounded-md border border-line bg-inset/40 p-2.5">
        <HardDrive className="mt-0.5 size-3.5 shrink-0 text-muted" />
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          Everything below is <span className="font-medium text-secondary">this browser</span> on{" "}
          <code className="cm-mono !text-xs text-fg">{origin}</code>. The installed app, a dev server on
          another port, and your phone each keep their own storage — clearing something here touches
          nothing anywhere else.
        </p>
        <IconButton tip="Measure again" disabled={busy !== null} onClick={() => void run("refresh", async () => {})}>
          <RefreshCw />
        </IconButton>
      </div>

      {/* ------------------------------------------------------------- origin */}
      <div className="space-y-2 border-b border-line-soft pb-3">
        <SectionLabel className="px-0">This origin</SectionLabel>
        {estimate ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-secondary">
                <span className="font-medium text-primary">{bytes(estimate.usage)}</span> used of{" "}
                {bytes(estimate.quota)} the browser will allow
              </span>
              <span className="cm-mono !text-2xs text-faint">
                {pctOf(estimate.usage, estimate.quota).toFixed(estimate.usage / estimate.quota < 0.01 ? 2 : 0)}%
              </span>
            </div>
            <SplitBar
              usedPct={pctOf(estimate.usage, estimate.quota)}
              // Clamped to `usage`: the estimate is rounded and padded for
              // privacy while the cache counts its own bytes exactly, so on a
              // small origin the slice can outrun the whole it belongs to.
              sharePct={pctOf(Math.min(cache.bytes, estimate.usage), estimate.quota)}
              size="lg"
              title={`${bytes(cache.bytes)} artifact cache · ${bytes(estimate.usage)} used · ${bytes(estimate.quota)} quota`}
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted">
              <span className="flex items-center gap-1.5">
                <SplitDot layer="share" /> Artifact cache {bytes(cache.bytes)}
              </span>
              <span className="flex items-center gap-1.5">
                <SplitDot layer="other" /> Everything else {bytes(Math.max(0, estimate.usage - cache.bytes))}
              </span>
              <span className="flex items-center gap-1.5">
                <SplitDot layer="free" /> Free {bytes(Math.max(0, estimate.quota - estimate.usage))}
              </span>
            </div>
            {estimate.details && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-2xs">
                {Object.entries(estimate.details)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted">{usageDetailLabel(k)}</dt>
                      <dd className="cm-mono !text-2xs text-secondary">{bytes(v)}</dd>
                    </div>
                  ))}
              </dl>
            )}
            <p className="text-2xs leading-snug text-faint">
              Browsers round these figures and pad them for privacy, so they move in steps rather
              than byte by byte. The quota is a share of free disk the browser picks, not a promise.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted">This browser doesn&apos;t report how much storage it uses.</p>
        )}
      </div>

      {/* -------------------------------------------------------- persistence */}
      <div className="space-y-2 border-b border-line-soft pb-3">
        <SectionLabel className="px-0">Persistence</SectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          {survey.persisted === null ? (
            <Chip tone="muted">Not reported</Chip>
          ) : survey.persisted ? (
            <Chip tone="success" icon={<ShieldCheck />}>
              Persistent
            </Chip>
          ) : (
            <Chip tone="neutral">Best-effort</Chip>
          )}
          {survey.persisted === false && (
            <Button
              leftIcon={busy === "persist" ? <Spinner size={12} /> : <ShieldCheck />}
              disabled={busy !== null}
              onClick={() =>
                void run("persist", async () => {
                  setPersistAsked(await requestPersist());
                })
              }
            >
              Keep this data
            </Button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted">
          {survey.persisted
            ? "The browser has agreed not to clear this origin's storage to make room. It is still yours to clear, here or in the browser's site settings."
            : "Best-effort storage can be cleared by the browser, without asking, when the disk runs low — the artifact cache and the app shell would simply be fetched again."}
        </p>
        {persistAsked === false && (
          <p className="text-xs leading-relaxed text-warn">
            The browser said no. Chromium decides on its own, without a prompt, from how you use the
            site — installing Dispatch as an app, bookmarking it or allowing notifications all count —
            so asking again later may succeed. Nothing is lost by a refusal; it only means storage
            stays best-effort.
          </p>
        )}
      </div>

      {/* ----------------------------------------------------- artifact cache */}
      <div className="space-y-2 border-b border-line-soft pb-3">
        <div className="flex items-center gap-2">
          <SectionLabel className="px-0">Artifact cache</SectionLabel>
          {cache.available && cache.entries > 0 && (
            <Button
              variant="danger"
              className="ml-auto"
              leftIcon={busy === "all" ? <Spinner size={12} /> : <Trash2 />}
              disabled={busy !== null}
              onClick={() => void run("all", () => clearArtifactCache())}
            >
              Clear all
            </Button>
          )}
        </div>
        {!cache.available ? (
          <p className="text-xs leading-relaxed text-muted">
            <span className="font-medium text-warn">Unavailable in this browser.</span> IndexedDB is
            refused here — usually a private window, or storage blocked for the site. Artifacts still
            open; each one downloads every time.
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-secondary">
                <span className="font-medium text-primary">{bytes(cache.bytes)}</span>
                {limits.totalMaxBytes > 0 ? <> of {bytes(limits.totalMaxBytes)}</> : null}
                <span className="text-muted">
                  {" "}
                  · {cache.entries} {cache.entries === 1 ? "entry" : "entries"}
                </span>
              </span>
              {limits.totalMaxBytes === 0 && <Chip tone="muted">Off</Chip>}
            </div>
            {limits.totalMaxBytes > 0 && (
              <SplitBar
                usedPct={pctOf(cache.bytes, limits.totalMaxBytes)}
                // Over the limit is transient (eviction runs on the next
                // write), but a full bar in the normal tone would read as
                // "exactly at the limit" rather than "past it".
                tone={cache.bytes > limits.totalMaxBytes ? "bg-warn" : "bg-accent"}
                size="md"
                title={`${bytes(cache.bytes)} of ${bytes(limits.totalMaxBytes)}`}
              />
            )}
            {cache.projects.length === 0 ? (
              <p className="text-2xs text-faint">
                Nothing cached yet. Artifacts are kept here as you open them, and the active
                project&apos;s are fetched ahead of time when an agent publishes one.
              </p>
            ) : (
              <div className="space-y-2">
                {cache.projects.map((p) => {
                  const cap = artifactCacheLimits(p.projectId).projectMaxBytes;
                  const capped = cap > 0 && cap < limits.totalMaxBytes;
                  return (
                    <div key={p.projectId} className="rounded-md border border-line bg-inset/40 p-2.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-primary" title={p.projectId}>
                          {projectName.get(p.projectId) ?? p.projectId}
                        </span>
                        <span className="cm-mono !text-2xs shrink-0 text-secondary">
                          {bytes(p.bytes)}
                          {capped && <span className="text-faint"> / {bytes(cap)}</span>}
                        </span>
                        <IconButton
                          tip="Clear this project's cached artifacts"
                          disabled={busy !== null}
                          onClick={() => void run(`p:${p.projectId}`, () => clearArtifactCache({ projectId: p.projectId }))}
                        >
                          {busy === `p:${p.projectId}` ? <Spinner size={12} /> : <Eraser />}
                        </IconButton>
                      </div>
                      <ul className="mt-1.5 space-y-0.5">
                        {p.chats.map((c) => (
                          <li key={c.chatId} className="flex items-center gap-2 pl-2 text-2xs">
                            <span className="min-w-0 flex-1 truncate text-secondary" title={c.chatId}>
                              {chats[c.chatId]?.title || c.chatId}
                            </span>
                            <span className="shrink-0 text-faint">
                              {c.artifacts} {c.artifacts === 1 ? "artifact" : "artifacts"}
                              {c.versions !== c.artifacts && ` · ${c.versions} versions`}
                              {c.blobs > 0 && ` · ${c.blobs} ${c.blobs === 1 ? "file" : "files"}`}
                            </span>
                            <span className="cm-mono !text-2xs w-14 shrink-0 text-right text-secondary">{bytes(c.bytes)}</span>
                            <IconButton
                              tip="Clear this chat's cached artifacts"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(`c:${c.chatId}`, () =>
                                  clearArtifactCache({ projectId: p.projectId, chatId: c.chatId }),
                                )
                              }
                            >
                              {busy === `c:${c.chatId}` ? <Spinner size={12} /> : <Eraser />}
                            </IconButton>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
        {pane && <CacheLimitFields {...pane} />}
      </div>

      {/* ------------------------------------------------------ other storage */}
      <div className="space-y-3">
        <SectionLabel className="px-0">Everything else</SectionLabel>
        <WebStorageBlock
          label="localStorage"
          blurb="Per-browser preferences — theme, panel sizes, drafts, what you last had open. Kept until you clear it."
          survey={survey.local}
        />
        <WebStorageBlock
          label="sessionStorage"
          blurb="Scratch state for this tab only. Gone when the tab closes."
          survey={survey.session}
        />

        <div className="space-y-1">
          <div className="text-xs font-medium text-secondary">Cache Storage (service worker)</div>
          {survey.caches === null ? (
            <p className="text-2xs text-faint">Not available in this browser.</p>
          ) : survey.caches.length === 0 ? (
            <p className="text-2xs text-faint">Empty — no service worker cache on this origin.</p>
          ) : (
            <ul className="space-y-0.5">
              {survey.caches.map((c) => (
                <li key={c.name} className="flex items-center gap-2 text-2xs">
                  <code className="cm-mono !text-2xs min-w-0 flex-1 truncate text-secondary">{c.name}</code>
                  <span className="shrink-0 text-faint">
                    {c.role === "shell"
                      ? "app shell, refilled on the next load"
                      : c.role === "push"
                        ? "push device id — kept"
                        : `${c.entries} entries`}
                  </span>
                  <span className="cm-mono !text-2xs w-14 shrink-0 text-right text-secondary">
                    {c.bytes == null ? "—" : bytes(c.bytes)}
                  </span>
                  {c.clearable ? (
                    <IconButton
                      tip="Clear the app-shell cache — the next load fetches it again"
                      disabled={busy !== null}
                      onClick={() => void run(`sw:${c.name}`, () => deleteCache(c.name))}
                    >
                      {busy === `sw:${c.name}` ? <Spinner size={12} /> : <Eraser />}
                    </IconButton>
                  ) : (
                    // Same width as the button, so the size column stays aligned.
                    <span className="size-6 shrink-0" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1">
          <div className="text-xs font-medium text-secondary">IndexedDB databases</div>
          {survey.idb === null ? (
            <p className="text-2xs text-faint">This browser doesn&apos;t list its databases.</p>
          ) : survey.idb.length === 0 ? (
            <p className="text-2xs text-faint">None.</p>
          ) : (
            <ul className="space-y-0.5">
              {survey.idb.map((d) => (
                <li key={d.name} className="flex items-center gap-2 text-2xs">
                  <code className="cm-mono !text-2xs min-w-0 flex-1 truncate text-secondary">{d.name}</code>
                  <span className="shrink-0 text-faint">v{d.version}</span>
                  <span className="cm-mono !text-2xs w-14 shrink-0 text-right text-secondary">
                    {d.name === "dispatch-artifacts" && cache.available ? bytes(cache.bytes) : "—"}
                  </span>
                  <span className="size-6 shrink-0" />
                </li>
              ))}
            </ul>
          )}
          <p className="text-2xs leading-snug text-faint">
            Browsers report one IndexedDB total, not a size per database; only the artifact cache
            counts its own.
          </p>
        </div>
      </div>
    </div>
  );
}

function WebStorageBlock({ label, blurb, survey }: { label: string; blurb: string; survey: WebStorageSurvey }) {
  const [all, setAll] = useState(false);
  const shown = all ? survey.keys : survey.keys.slice(0, KEYS_SHOWN);
  const rest = survey.keys.slice(shown.length);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-secondary">{label}</span>
        <span className="text-2xs text-faint">
          {survey.available
            ? `${survey.keys.length} ${survey.keys.length === 1 ? "key" : "keys"}`
            : "blocked"}
        </span>
        <span className="cm-mono !text-2xs ml-auto w-14 shrink-0 text-right text-secondary">
          {survey.available ? bytes(survey.bytes) : "—"}
        </span>
        <span className="size-6 shrink-0" />
      </div>
      <p className="text-2xs leading-snug text-faint">{blurb}</p>
      {shown.length > 0 && (
        <ul className="space-y-0.5 pl-2">
          {shown.map((k) => (
            <li key={k.key} className="flex items-center gap-2 text-2xs">
              <code className="cm-mono !text-2xs min-w-0 flex-1 truncate text-muted" title={k.key}>
                {k.key}
              </code>
              <span className="cm-mono !text-2xs w-14 shrink-0 text-right text-muted">{bytes(k.bytes)}</span>
              <span className="size-6 shrink-0" />
            </li>
          ))}
          {rest.length > 0 && (
            <li>
              <Button variant="link" onClick={() => setAll(true)}>
                {rest.length} more · {bytes(rest.reduce((n, k) => n + k.bytes, 0))}
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * The two budgets, edited in the page draft. Validated here as well as by the
 * server's schema so an out-of-range number is explained beside the field it
 * came from, not as a zod message in the save bar.
 */
function CacheLimitFields({ draft, patch }: AppPaneProps) {
  const r = draft.retention ?? {};
  const set = (p: Partial<typeof r>) => patch({ retention: { ...r, ...p } });
  const cacheErr =
    r.artifactCacheMb != null && r.artifactCacheMb > ARTIFACT_CACHE_MB_CEILING
      ? `At most ${ARTIFACT_CACHE_MB_CEILING.toLocaleString()} MB.`
      : null;
  const preloadErr =
    r.artifactPreloadMb != null && r.artifactPreloadMb > ARTIFACT_PRELOAD_MB_CEILING
      ? `At most ${ARTIFACT_PRELOAD_MB_CEILING} MB — no asset bundle is larger.`
      : null;
  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap gap-3">
        <Field
          label="Cache up to, MB"
          hint="0 = off"
          className="w-44"
        >
          <TextInput
            inputMode="numeric"
            aria-label="Artifact cache limit (MB)"
            placeholder={`${DEFAULT_ARTIFACT_CACHE_MB} (default)`}
            aria-invalid={cacheErr ? true : undefined}
            value={r.artifactCacheMb == null ? "" : String(r.artifactCacheMb)}
            onChange={(e) => set({ artifactCacheMb: numberField(e.target.value) })}
          />
        </Field>
        <Field
          label="Preload files up to, MB"
          hint="0 = page only"
          className="w-52"
        >
          <TextInput
            inputMode="numeric"
            aria-label="Artifact preload limit (MB)"
            placeholder={`${DEFAULT_ARTIFACT_PRELOAD_MB} (default)`}
            aria-invalid={preloadErr ? true : undefined}
            value={r.artifactPreloadMb == null ? "" : String(r.artifactPreloadMb)}
            onChange={(e) => set({ artifactPreloadMb: numberField(e.target.value) })}
          />
        </Field>
      </div>
      {(cacheErr || preloadErr) && <p className="text-xs text-danger">{cacheErr ?? preloadErr}</p>}
      <p className="text-xs leading-relaxed text-muted">
        Saved on the server, so every browser gets the same numbers — and each one applies them to
        its own storage. Lowering the cache evicts the least recently opened artifacts the moment you
        save. Preloading fetches an artifact&apos;s files before you open it when an agent publishes
        one in the project you have open; it is skipped on a connection with Data Saver on. A project
        can narrow both in its own settings, under Retention.
      </p>
    </div>
  );
}
