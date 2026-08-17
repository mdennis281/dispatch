/**
 * `pickPath()` — the file dialog this app can't get from the browser.
 *
 * The OS dialog is unusable here: `<input type=file>` hands back a `File`
 * object with a bare basename and no path, which is exactly the one thing a
 * caller needs when the answer has to be given to an agent running on the
 * server. So the picker is ours, and this is its front door.
 *
 * Promise-based on purpose. A picker is a QUESTION, and the call sites that ask
 * it — "which folder is the worktree root", "attach an image" — read as one
 * line when it's an await and as three pieces of scattered state when it's a
 * rendered `<Modal open={...}>` with an `onSelect` callback:
 *
 *   const paths = await pickPath({ select: "directory" });
 *   if (!paths) return;                       // cancelled
 *
 * One request at a time. A second call while a picker is open resolves the
 * first as cancelled rather than stacking two dialogs — which would leave two
 * awaits live and no way for the user to tell which one Escape answers.
 */
import { create } from "zustand";
import type { FsFilter, FsSelectKind } from "@dispatch/shared";

export interface PickPathOptions {
  /** Files, directories, or either. Default `"file"`. */
  select?: FsSelectKind;
  /** Acceptable extensions, with or without the dot. Files only. */
  extensions?: string[];
  /** Allow more than one answer. Default false. */
  multiple?: boolean;
  /** Start with hidden entries shown. Default false. */
  showHidden?: boolean;
  /** Where to open. Defaults to the server's home directory. */
  initialPath?: string;
  /**
   * Seed the search box.
   *
   * For the case where the caller already knows what is being looked for but
   * not where it is — dropping a file from a file manager discloses only its
   * basename, so the picker opens already searching for that name rather than
   * making you retype what you just dragged.
   */
  initialQuery?: string;
  /** Dialog heading. Defaults to a sentence derived from the filter. */
  title?: string;
}

export interface PickRequest {
  id: number;
  filter: FsFilter;
  initialPath?: string;
  initialQuery?: string;
  title?: string;
  /** Resolves the awaiting `pickPath` call. Null means cancelled. */
  settle: (paths: string[] | null) => void;
}

interface FilePickerState {
  request: PickRequest | null;
  open: (request: PickRequest) => void;
  close: () => void;
}

export const useFilePicker = create<FilePickerState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

let nextId = 1;

/**
 * Ask the user for one or more paths. Resolves to absolute, forward-slashed
 * paths, or `null` if they cancelled — which is a normal answer, not an error,
 * so it does not reject.
 */
export function pickPath(opts: PickPathOptions = {}): Promise<string[] | null> {
  // Cancel whatever is already open. Its awaiting caller gets `null`, which is
  // the same thing it would have got from an Escape — so no call site needs a
  // special case for "someone opened another picker on top of me".
  useFilePicker.getState().request?.settle(null);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (paths: string[] | null) => {
      if (settled) return;
      settled = true;
      useFilePicker.setState((s) => (s.request?.id === id ? { request: null } : s));
      resolve(paths);
    };
    const id = nextId++;
    useFilePicker.getState().open({
      id,
      title: opts.title,
      initialPath: opts.initialPath,
      initialQuery: opts.initialQuery,
      filter: {
        select: opts.select ?? "file",
        extensions: opts.extensions?.map((e) => e.replace(/^\./, "").toLowerCase()),
        multiple: opts.multiple ?? false,
        showHidden: opts.showHidden ?? false,
      } satisfies FsFilter,
      settle,
    });
  });
}

/** Convenience for the overwhelmingly common single-answer case. */
export async function pickOnePath(
  opts: Omit<PickPathOptions, "multiple"> = {},
): Promise<string | null> {
  const paths = await pickPath({ ...opts, multiple: false });
  return paths?.[0] ?? null;
}
