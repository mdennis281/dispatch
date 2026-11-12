/**
 * Plugin catalogs: collection URLs the host remembers, reads on a schedule and
 * serves from a cache, so Settings → Plugins can list what there is to install
 * without anyone pasting a URL. See plugin-catalog.ts for what a catalog is.
 *
 * A refresh is the SAME `PluginInspector.inspect` the Inspect-from-URL box
 * runs — every member's full report, fetched as a tarball and scanned — so
 * what the detail view shows before Install is what a pasted URL would have
 * shown. Nothing here installs anything.
 *
 * The cache is a file in the per-instance data dir rather than memory: a
 * catalog read is a tarball download plus a scan per member, and a restart
 * should not leave the browse list empty for the minutes until the first
 * pass. One writer per instance (this service), written whole via rename.
 *
 * `installed` in every cached report is RE-READ on the way out
 * (`installedState`): the listing is hours old, the install state is not.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as z from "zod";
import {
  BUILTIN_PLUGIN_CATALOG,
  MAX_PLUGIN_CATALOGS,
  PluginCollectionInspectionSchema,
  PluginInspectionSchema,
  catalogIdFor,
  isPluginCollection,
  sameCatalogUrl,
  type PluginCatalog,
  type PluginCatalogMember,
  type PluginCatalogSettings,
  type PluginCatalogsStatus,
  type PluginCollectionEntry,
  type PluginInspectResult,
  type PluginInspection,
} from "@dispatch/shared";
import type { AppSettings } from "../../store/index.js";
import { clampPluginUpdateHours } from "./watcher.js";
import { PluginInspectError, parsePluginUrl } from "./url.js";
import type { PluginInspector } from "./index.js";

const HOUR = 3_600_000;

export interface PluginCatalogServiceOptions {
  inspector: Pick<PluginInspector, "inspect" | "installedState" | "judged">;
  settings: {
    get: () => Promise<AppSettings>;
    update: (fn: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
  };
  /** `<dataDir>/plugin-catalogs.json`. Absent = memory only (tests). */
  cacheFile?: string;
  /** 0 switches background refreshes off; the buttons still work. */
  intervalHours: number;
  firstRunMs?: number;
  now?: () => number;
}

/** What a refresh learned, kept until the next one SUCCEEDS. */
const CacheEntrySchema = z.object({
  url: z.string(),
  refreshedAt: z.number().optional(),
  attemptedAt: z.number().optional(),
  error: z.string().optional(),
  result: z.union([PluginCollectionInspectionSchema, PluginInspectionSchema]).optional(),
});
type CacheEntry = z.infer<typeof CacheEntrySchema>;
const CacheFileSchema = z.object({ version: z.literal(1), catalogs: z.record(z.string(), CacheEntrySchema) });

interface CatalogConfig {
  id: string;
  url: string;
  label: string;
  builtin: boolean;
  enabled: boolean;
}

export class PluginCatalogNotFound extends PluginInspectError {
  constructor(id: string) {
    super(`no plugin catalog "${id}"`, 404);
  }
}

/** One member row, or none when the report is gone — a single-plugin catalog is a one-row collection. */
function entriesOf(result: PluginInspectResult): PluginCollectionEntry[] {
  if (isPluginCollection(result)) return result.plugins;
  return [{ subdir: result.source.subdir, report: result }];
}

export class PluginCatalogService {
  private cache = new Map<string, CacheEntry>();
  private loaded: Promise<void> | null = null;
  private refreshing = new Map<string, Promise<void>>();
  private firstTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt?: number;
  private stopped = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly intervalHours: number;

  constructor(private readonly opts: PluginCatalogServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.intervalHours = clampPluginUpdateHours(opts.intervalHours);
  }

  /* ---------------------------------------------------------- schedule */

  start(): void {
    if (this.intervalHours <= 0 || this.timer || this.stopped) return;
    // After the update watcher's first pass (2 min), not alongside it: both
    // fetch from the same hosts, and boot is not the moment to do it twice.
    const first = this.opts.firstRunMs ?? 3 * 60_000;
    this.nextRunAt = this.now() + first;
    this.firstTimer = setTimeout(() => void this.refreshAll().catch(() => {}), first);
    this.firstTimer.unref?.();
    const every = this.intervalHours * HOUR;
    this.timer = setInterval(() => void this.refreshAll().catch(() => {}), every);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.refreshing.values()]);
    await this.writeChain.catch(() => {});
  }

  /* ------------------------------------------------------------ config */

  private async configs(): Promise<CatalogConfig[]> {
    const s: PluginCatalogSettings = (await this.opts.settings.get()).pluginCatalogs ?? {};
    const off = new Set(s.disabled ?? []);
    return [
      { ...BUILTIN_PLUGIN_CATALOG, builtin: true, enabled: !off.has(BUILTIN_PLUGIN_CATALOG.id) },
      ...(s.added ?? []).map((a) => ({
        id: a.id,
        url: a.url,
        label: a.label || a.url.replace(/^https:\/\/(?:www\.)?github\.com\//, ""),
        builtin: false,
        enabled: !off.has(a.id),
      })),
    ];
  }

  private async config(id: string): Promise<CatalogConfig> {
    const c = (await this.configs()).find((x) => x.id === id);
    if (!c) throw new PluginCatalogNotFound(id);
    return c;
  }

  /**
   * Add a catalog — only once it has been READ: a URL that holds no plugin is
   * refused with the inspector's reason rather than saved as a row that will
   * fail every six hours.
   */
  async add(url: string, label?: string): Promise<PluginCatalog> {
    parsePluginUrl(url);
    const current = await this.configs();
    const dup = current.find((c) => sameCatalogUrl(c.url, url));
    if (dup) throw new PluginInspectError(`already listed as "${dup.label}"`, 409);
    if (current.length >= MAX_PLUGIN_CATALOGS) throw new PluginInspectError(`at most ${MAX_PLUGIN_CATALOGS} catalogs`, 409);
    const result = await this.opts.inspector.inspect(url);
    const id = catalogIdFor(url, current.map((c) => c.id));
    const at = this.now();
    await this.opts.settings.update((s) => ({
      ...s,
      pluginCatalogs: {
        ...s.pluginCatalogs,
        added: [...(s.pluginCatalogs?.added ?? []), { id, url: url.trim(), ...(label?.trim() ? { label: label.trim() } : {}), addedAt: at }],
      },
    }));
    await this.loadCache();
    this.cache.set(id, { url: url.trim(), refreshedAt: at, attemptedAt: at, result });
    this.persist();
    return this.view(await this.config(id));
  }

  async remove(id: string): Promise<void> {
    const c = await this.config(id);
    if (c.builtin) throw new PluginInspectError("the built-in catalog cannot be removed — switch it off instead", 409);
    await this.opts.settings.update((s) => ({
      ...s,
      pluginCatalogs: {
        ...s.pluginCatalogs,
        added: (s.pluginCatalogs?.added ?? []).filter((a) => a.id !== id),
        disabled: (s.pluginCatalogs?.disabled ?? []).filter((d) => d !== id),
      },
    }));
    await this.loadCache();
    this.cache.delete(id);
    this.persist();
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginCatalog> {
    await this.config(id);
    await this.opts.settings.update((s) => {
      const off = new Set(s.pluginCatalogs?.disabled ?? []);
      if (enabled) off.delete(id);
      else off.add(id);
      return { ...s, pluginCatalogs: { ...s.pluginCatalogs, disabled: [...off] } };
    });
    const c = await this.config(id);
    // Switched on with nothing cached (never read, or off since before this
    // instance existed): read it now rather than show an empty catalog for hours.
    if (enabled) {
      await this.loadCache();
      if (!this.cache.get(id)?.result) await this.refresh(id);
    }
    return this.view(c);
  }

  /* ----------------------------------------------------------- refresh */

  /** Re-read one catalog. Joins a refresh of it already running. Never throws for a fetch failure — that is the row's `error`. */
  async refresh(id: string): Promise<PluginCatalog> {
    const c = await this.config(id);
    if (!c.enabled) throw new PluginInspectError(`"${c.label}" is switched off`, 409);
    let running = this.refreshing.get(id);
    if (!running) {
      running = this.read(c).finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, running);
    }
    await running;
    return this.view(await this.config(id));
  }

  /** Every enabled catalog, two at a time. */
  async refreshAll(): Promise<PluginCatalogsStatus> {
    const queue = (await this.configs()).filter((c) => c.enabled);
    const worker = async () => {
      for (let c = queue.shift(); c && !this.stopped; c = queue.shift()) await this.refresh(c.id).catch(() => {});
    };
    await Promise.all([worker(), worker()]);
    if (this.timer) this.nextRunAt = this.now() + this.intervalHours * HOUR;
    return this.status();
  }

  private async read(c: CatalogConfig): Promise<void> {
    await this.loadCache();
    const at = this.now();
    const prev = this.cache.get(c.id);
    // A listing of a DIFFERENT url (the entry was removed and re-added
    // pointing elsewhere under a reused id) is not a fallback for this one.
    const keep = prev && sameCatalogUrl(prev.url, c.url) ? prev : undefined;
    try {
      const result = await this.opts.inspector.inspect(c.url);
      this.cache.set(c.id, { url: c.url, refreshedAt: at, attemptedAt: at, result });
    } catch (err) {
      this.cache.set(c.id, {
        url: c.url,
        ...(keep?.refreshedAt ? { refreshedAt: keep.refreshedAt } : {}),
        ...(keep?.result ? { result: keep.result } : {}),
        attemptedAt: at,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.persist();
  }

  /* -------------------------------------------------------------- read */

  async status(): Promise<PluginCatalogsStatus> {
    await this.loadCache();
    const catalogs = await Promise.all((await this.configs()).map((c) => this.view(c)));
    return {
      intervalHours: this.intervalHours,
      ...(this.nextRunAt && this.timer ? { nextRunAt: this.nextRunAt } : {}),
      catalogs,
    };
  }

  /** One member's FULL report, as cached, with `installed` as of now — what the detail view renders. */
  async member(id: string, subdir: string): Promise<PluginInspection> {
    const c = await this.config(id);
    await this.loadCache();
    const entry = this.usable(c);
    const row = entry?.result ? entriesOf(entry.result).find((e) => e.subdir === subdir) : undefined;
    if (!row) throw new PluginInspectError(`"${c.label}" lists no plugin at ${subdir || "(root)"}`, 404);
    if (!row.report) throw new PluginInspectError(row.error ?? `no report for ${subdir}`, 404);
    // Dependencies judged as of now, too, with the catalog's other members as
    // siblings: a provider installed since the refresh makes its consumer
    // installable, and one removed since makes it not.
    const report = this.opts.inspector.judged(row.report, entriesOf(entry!.result!));
    const installed = await this.opts.inspector.installedState(report);
    const { installed: _stale, ...rest } = report;
    return { ...rest, ...(installed ? { installed } : {}) };
  }

  private usable(c: CatalogConfig): CacheEntry | undefined {
    const e = this.cache.get(c.id);
    return e && sameCatalogUrl(e.url, c.url) ? e : undefined;
  }

  private async view(c: CatalogConfig): Promise<PluginCatalog> {
    const e = c.enabled ? this.usable(c) : undefined;
    const r = e?.result;
    const plugins: PluginCatalogMember[] = r ? await Promise.all(entriesOf(r).map((m, _i, all) => this.memberRow(m, all))) : [];
    const collection = r && isPluginCollection(r) ? r : undefined;
    return {
      id: c.id,
      url: c.url,
      label: c.label,
      builtin: c.builtin,
      enabled: c.enabled,
      refreshing: this.refreshing.has(c.id),
      ...(e?.refreshedAt ? { refreshedAt: e.refreshedAt } : {}),
      ...(e?.attemptedAt ? { attemptedAt: e.attemptedAt } : {}),
      ...(e?.error ? { error: e.error } : {}),
      ...(collection?.name ? { name: collection.name } : {}),
      ...(collection?.description ? { description: collection.description } : {}),
      ...(r ? { ref: r.source.ref, sha: r.source.sha } : {}),
      ...(r?.source.browseUrl ? { browseUrl: r.source.browseUrl } : {}),
      manifestErrors: collection?.manifestErrors ?? [],
      plugins,
    };
  }

  private async memberRow(m: PluginCollectionEntry, all: readonly PluginCollectionEntry[]): Promise<PluginCatalogMember> {
    const r = m.report ? this.opts.inspector.judged(m.report, all) : undefined;
    if (!r) return { subdir: m.subdir, capabilities: [], installable: false, warnings: 0, error: m.error ?? "unreadable" };
    const installed = await this.opts.inspector.installedState(r);
    return {
      subdir: m.subdir,
      ...(r.id ? { id: r.id } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(r.version ? { version: r.version } : {}),
      ...(r.description ? { description: r.description } : {}),
      capabilities: r.capabilities.map((c) => c.name),
      installable: r.installable,
      ...(r.refusal ? { refusal: r.refusal } : {}),
      warnings: r.warnings.length,
      ...(installed ? { installed } : {}),
    };
  }

  /* ------------------------------------------------------------- cache */

  private loadCache(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.opts.cacheFile) return;
      try {
        const parsed = CacheFileSchema.safeParse(JSON.parse(await readFile(this.opts.cacheFile, "utf8")));
        // A cache from another version of the report schema is a cache miss,
        // not an error: the next refresh rewrites it.
        if (parsed.success) for (const [id, e] of Object.entries(parsed.data.catalogs)) this.cache.set(id, e);
      } catch {
        /* none yet, or unreadable — same answer */
      }
    })();
    return this.loaded;
  }

  /** Serialised so two refreshes finishing together cannot interleave their renames. */
  private persist(): void {
    const file = this.opts.cacheFile;
    if (!file) return;
    this.writeChain = this.writeChain
      .then(async () => {
        const body = JSON.stringify({ version: 1, catalogs: Object.fromEntries(this.cache) });
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, body, "utf8");
        await rename(tmp, file);
      })
      .catch(() => {});
  }
}
