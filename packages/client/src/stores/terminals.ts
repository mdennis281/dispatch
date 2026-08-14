import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { TerminalInfo } from "@dispatch/shared";

/** One line of terminal I/O for the read-only view. */
export interface TerminalLine {
  stream: "command" | "stdout" | "stderr";
  chunk: string;
  ts: number;
}

interface TerminalsStore {
  byId: Record<string, TerminalInfo>;
  order: string[];
  lines: Record<string, TerminalLine[]>;

  hydrate: (terminals: TerminalInfo[], lines?: Record<string, TerminalLine[]>) => void;
  upsert: (terminal: TerminalInfo) => void;
  close: (id: string) => void;
  appendLine: (id: string, line: TerminalLine) => void;
  /** Replace a terminal's scrollback (lazy fetch on panel open). */
  setLines: (id: string, lines: TerminalLine[]) => void;
}

const LINE_CAP = 1000;

export const useTerminals = create<TerminalsStore>((set) => ({
  byId: {},
  order: [],
  lines: {},

  hydrate: (terminals, lines = {}) => {
    const byId: Record<string, TerminalInfo> = {};
    for (const t of terminals) byId[t.id] = t;
    set({ byId, order: terminals.map((t) => t.id), lines });
  },

  upsert: (terminal) =>
    set((s) => ({
      byId: { ...s.byId, [terminal.id]: terminal },
      order: s.order.includes(terminal.id) ? s.order : [...s.order, terminal.id],
    })),

  close: (id) =>
    set((s) => {
      if (!s.byId[id]) return s;
      const byId = { ...s.byId };
      delete byId[id];
      const lines = { ...s.lines };
      delete lines[id];
      return { byId, lines, order: s.order.filter((x) => x !== id) };
    }),

  appendLine: (id, line) =>
    set((s) => {
      const next = [...(s.lines[id] ?? []), line];
      if (next.length > LINE_CAP) next.splice(0, next.length - LINE_CAP);
      return { lines: { ...s.lines, [id]: next } };
    }),

  setLines: (id, lines) => set((s) => ({ lines: { ...s.lines, [id]: lines } })),
}));

/** One chat's shells that still have a process behind them. */
export function isLiveChatTerminal(
  terminal: TerminalInfo | undefined,
  chatId: string,
): terminal is TerminalInfo {
  return !!terminal && terminal.chatId === chatId && terminal.status === "live";
}

/**
 * A free name for a human-opened shell: `shell`, then `shell 2`, `shell 3`…
 *
 * Shells are keyed by `${chatId}::${name}`, so re-using a live name silently
 * hands back the SAME shell — fine for an agent, which picks a name on purpose
 * ("build", "server"), and wrong for a "New shell" button, where two clicks
 * must mean two shells. Naming is the only reason that button would otherwise
 * need a dialog, and a dialog in front of the panel that nobody found is
 * exactly the wrong trade.
 */
export function nextShellName(taken: readonly string[], base = "shell"): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Selector: terminals scoped to a chat (right-panel "Terminals"). */
export function useChatTerminals(chatId: string | null): TerminalInfo[] {
  return useTerminals(
    useShallow((s) =>
      s.order
        .map((id) => s.byId[id]!)
        .filter((t): t is TerminalInfo => !!t && (!chatId || t.chatId === chatId)),
    ),
  );
}
