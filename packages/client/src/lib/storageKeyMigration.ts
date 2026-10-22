/**
 * One-time move of browser storage keys from the pre-rename `cm:` / `cm.`
 * prefix to `dispatch:`.
 *
 * Unsent composer drafts, the remembered project, layout and notification
 * prefs all lived under `cm:…` (and the workspace view under `cm.…`). Renaming
 * the keys in code without moving the stored values would silently drop every
 * user's drafts and preferences on the first load of the new build — so this
 * copies each one across before anything reads storage, then removes the old
 * key so it runs exactly once.
 *
 * An existing new-name value wins: it can only have been written by the new
 * build, which makes it the more recent of the two.
 *
 * Runs at module evaluation, and `main.tsx` imports it FIRST: several stores
 * read storage while their own modules evaluate, and ES modules evaluate in
 * import order, so this has finished before any of them looks.
 */

const OLD_PREFIXES = ["cm:", "cm."];
const NEW_PREFIX = "dispatch:";

/** The new name for a pre-rename key, or null when `key` is not one. */
export function renamedKey(key: string): string | null {
  for (const prefix of OLD_PREFIXES) {
    if (key.startsWith(prefix)) return NEW_PREFIX + key.slice(prefix.length);
  }
  return null;
}

/** Move every pre-rename key in `store`. Returns how many were moved or dropped. */
export function migrateStorageKeys(store: Storage | undefined): number {
  if (!store) return 0;
  let moved = 0;
  try {
    // Snapshot first: removing keys while indexing `store.key(i)` skips entries.
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null) keys.push(key);
    }
    for (const key of keys) {
      const next = renamedKey(key);
      if (!next) continue;
      const value = store.getItem(key);
      if (value !== null && store.getItem(next) === null) store.setItem(next, value);
      store.removeItem(key);
      moved++;
    }
  } catch {
    // Blocked storage (private mode, a quota error mid-copy) — nothing to keep
    // that the app could have read anyway; never let it stop the boot.
  }
  return moved;
}

function storage(name: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return globalThis[name];
  } catch {
    return undefined; // accessing it throws outright when storage is disabled
  }
}

migrateStorageKeys(storage("localStorage"));
migrateStorageKeys(storage("sessionStorage"));
