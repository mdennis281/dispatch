import { create } from "zustand";

/**
 * Transient toast surface for `notice` / `error` WS events (rollback confirms,
 * interrupts, "no checkpoint", action failures). These used to be dropped on the
 * floor; the reducer now pushes them here and `<Toasts/>` renders a small,
 * auto-dismissing stack at the app corner. Purely ephemeral — never persisted.
 */
export type NoticeLevel = "info" | "warn" | "error";

export interface Toast {
  id: string;
  level: NoticeLevel;
  text: string;
  /** Optional secondary line (e.g. an error detail). */
  detail?: string;
  chatId?: string;
  createdAt: number;
}

/** How long a toast lingers before auto-dismiss (errors linger longer). */
const TTL: Record<NoticeLevel, number> = {
  info: 4_000,
  warn: 6_000,
  error: 9_000,
};
/** Cap the visible stack so a flurry of events can't tower off-screen. */
const MAX = 4;

interface NoticesStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "createdAt"> & { id?: string }) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let seq = 0;

export const useNotices = create<NoticesStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = t.id ?? `toast-${Date.now()}-${seq++}`;
    const toast: Toast = {
      id,
      level: t.level,
      text: t.text,
      detail: t.detail,
      chatId: t.chatId,
      createdAt: Date.now(),
    };
    set((s) => ({ toasts: [...s.toasts, toast].slice(-MAX) }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, TTL[toast.level]);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
