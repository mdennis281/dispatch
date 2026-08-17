/**
 * The server's filesystem, as far as the client needs to know it up front:
 * which path rules are in force, and where it's worth starting from.
 *
 * Global and fetched once because both are properties of the SERVER, not of a
 * surface — the modal picker and the full page would otherwise each fetch the
 * drive list, and each end up with its own idea of whether paths use `C:/` or
 * `/`. That last part matters more than it sounds: `platform` feeds every
 * breadcrumb, parent link and "is this inside that" comparison in the UI, so two
 * components disagreeing about it is two components computing different parents
 * for the same directory.
 *
 * It is deliberately the SERVER's platform. A Windows browser pointed at a Linux
 * Dispatch has to think in POSIX paths, because that is what the disk on the
 * other end is.
 */
import { create } from "zustand";
import type { FsPlatform, FsRoot } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface FsRootsState {
  /** Null until the first load lands — see `usePathPlatform` for the default. */
  platform: FsPlatform | null;
  roots: FsRoot[];
  home: string | null;
  loading: boolean;
  error: string | null;
  /** Fetch once; concurrent callers share the in-flight request. */
  load: () => Promise<void>;
  /** Re-fetch — a new project or a newly-mounted USB stick changes this list. */
  refresh: () => Promise<void>;
}

/** Shared in-flight promise, so N mounting components make ONE request. */
let inFlight: Promise<void> | null = null;

async function fetchRoots(set: (partial: Partial<FsRootsState>) => void): Promise<void> {
  set({ loading: true, error: null });
  try {
    const r = await api.fs.roots();
    set({ platform: r.platform, roots: r.roots, home: r.home, loading: false });
  } catch (err) {
    set({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export const useFsRoots = create<FsRootsState>((set, get) => ({
  platform: null,
  roots: [],
  home: null,
  loading: false,
  error: null,
  load: () => {
    if (get().platform && !get().error) return Promise.resolve();
    inFlight ??= fetchRoots(set).finally(() => {
      inFlight = null;
    });
    return inFlight;
  },
  refresh: () => {
    inFlight ??= fetchRoots(set).finally(() => {
      inFlight = null;
    });
    return inFlight;
  },
}));

/**
 * The path rules to compute with.
 *
 * Defaults to `posix` before the first load resolves. Any default is a guess for
 * one frame; POSIX is the one that degrades quietly — its rules leave a
 * Windows-shaped path alone (`C:/a/b` just isn't recognized as absolute), where
 * guessing `win32` against a POSIX path would start reading `/home` as a
 * UNC-ish shape and produce nonsense breadcrumbs.
 */
export function usePathPlatform(): FsPlatform {
  return useFsRoots((s) => s.platform) ?? "posix";
}
