/**
 * MemoryStatsStore — per-project ACCESS telemetry for durable memories.
 *
 * Tracks how often each memory actually earns its keep: `recalled` (an agent
 * explicitly searched and got it back — the strong "was needed" signal) and
 * `surfaced` (auto-pushed into a turn — a weaker, proactive signal), plus when
 * it was last touched. This is runtime signal, NOT source of truth: it lives in
 * the `.data` store (never the committable `.claude-manager/memory/` dir) so it
 * can't churn the repo, and a missing or corrupt file simply reads back as "no
 * stats yet".
 *
 * Used to (a) break ranking ties toward facts that keep proving useful and
 * (b) pick the "most-used" sample shown in the start-of-session injection, and
 * (c) flag never-retrieved memories as prune candidates for curation.
 */
import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { KeyedMutex } from "../store/fsq.js";
import type { Store } from "../store/index.js";

export type MemoryAccessKind = "surfaced" | "recalled";

export interface MemoryStat {
  /** Times auto-surfaced into a turn (the proactive push). */
  surfaced: number;
  /** Times returned by an explicit recall (the stronger "was needed" signal). */
  recalled: number;
  /** Last access time (epoch ms). */
  lastAccessedAt: number;
}

interface StatsFile {
  version: 1;
  entries: Record<string, MemoryStat>;
}

/** A fresh, zeroed stat row. */
function emptyStat(): MemoryStat {
  return { surfaced: 0, recalled: 0, lastAccessedAt: 0 };
}

/**
 * Combined usefulness score. An explicit recall weighs more than a proactive
 * surface: the agent went looking for it, which is the clearer signal that the
 * fact mattered. Higher = keep it prominent.
 */
export function usefulness(stat: MemoryStat | undefined): number {
  if (!stat) return 0;
  return stat.recalled * 2 + stat.surfaced;
}

export class MemoryStatsStore {
  private readonly store: Store;
  private readonly mutex = new KeyedMutex();

  constructor(store: Store) {
    this.store = store;
  }

  private file(projectId: string): string {
    return this.store.projectMemoryStatsFile(projectId);
  }

  /** Load a project's access stats (empty when the file is absent or unreadable). */
  async get(projectId: string): Promise<Record<string, MemoryStat>> {
    try {
      const raw = await readFile(this.file(projectId), "utf8");
      const parsed = JSON.parse(raw) as Partial<StatsFile>;
      if (parsed && parsed.entries && typeof parsed.entries === "object") {
        return parsed.entries as Record<string, MemoryStat>;
      }
    } catch {
      /* missing / corrupt → no stats yet */
    }
    return {};
  }

  /**
   * Record one access event against a set of memory names — increments the
   * matching counter and stamps `lastAccessedAt`. Serialized per-project so
   * concurrent sessions can't clobber the file. Best-effort by contract: callers
   * treat a rejection as "telemetry lost", never a failed operation.
   */
  async record(
    projectId: string,
    names: readonly string[],
    kind: MemoryAccessKind,
    at: number,
  ): Promise<void> {
    const unique = [...new Set(names.filter(Boolean))];
    if (!unique.length) return;
    await this.mutex.run(`memory-stats:${projectId}`, async () => {
      const entries = await this.get(projectId);
      for (const name of unique) {
        const cur = entries[name] ?? emptyStat();
        if (kind === "surfaced") cur.surfaced += 1;
        else cur.recalled += 1;
        cur.lastAccessedAt = at;
        entries[name] = cur;
      }
      await this.write(projectId, entries);
    });
  }

  /**
   * Drop stat rows whose memory no longer exists (deleted/renamed), so the file
   * doesn't accumulate orphans. No-op when nothing is stale.
   */
  async prune(projectId: string, liveNames: ReadonlySet<string>): Promise<void> {
    await this.mutex.run(`memory-stats:${projectId}`, async () => {
      const entries = await this.get(projectId);
      let changed = false;
      for (const name of Object.keys(entries)) {
        if (!liveNames.has(name)) {
          delete entries[name];
          changed = true;
        }
      }
      if (changed) await this.write(projectId, entries);
    });
  }

  /** Persist the entries map (must run under the per-project mutex). */
  private async write(projectId: string, entries: Record<string, MemoryStat>): Promise<void> {
    const file = this.file(projectId);
    await mkdir(dirname(file), { recursive: true });
    const payload: StatsFile = { version: 1, entries };
    await writeFile(file, JSON.stringify(payload), "utf8");
  }
}
