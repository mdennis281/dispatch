import { useCallback, useState } from "react";
import { api } from "../../lib/api.js";

/**
 * Kill a set of pids for a project, then re-scan. The Processes overlay and the
 * inline Processes panel each carried this handler verbatim, including the
 * partial-failure message, so the two surfaces could drift into reporting the
 * same failed kill differently.
 *
 * The re-scan runs whether the kill succeeded or not: a pid that refused to die
 * may still have taken its children with it.
 */
export function useKillProcesses(
  projectId: string | null | undefined,
  refresh: () => unknown,
): { kill: (pids: number[]) => Promise<void>; busy: boolean; killError: string | null } {
  const [busy, setBusy] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);

  const kill = useCallback(
    async (pids: number[]) => {
      if (!projectId || pids.length === 0) return;
      setBusy(true);
      setKillError(null);
      try {
        const results = await api.processes.kill(projectId, pids);
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          setKillError(
            `Failed to kill ${failed.length} process(es): ${failed
              .map((f) => `${f.pid} (${f.error ?? "unknown"})`)
              .join(", ")}`,
          );
        }
      } catch (err) {
        setKillError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [projectId, refresh],
  );

  return { kill, busy, killError };
}
