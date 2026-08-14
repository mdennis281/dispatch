/**
 * Which chat-config controls the composer actually shows.
 *
 * The composer toolbar accumulated every per-chat knob there is — mode, posture,
 * effort, model/agent, context meter, dictation, attach — and they are not
 * equally interesting to any one person. Someone who never changes model wants
 * that row quiet; someone tuning effort per turn wants effort visible even on a
 * narrow window, where the auto-compact layout collapses everything to icons.
 * Hiding a control never changes the chat's config, only whether this browser
 * draws it, so the honest fix is a visibility preference rather than a smarter
 * heuristic.
 *
 * Global (not per chat) and stored in localStorage: it's a statement about how
 * you like to work, not about one conversation. The store is a tiny zustand so a
 * toggle re-renders the toolbar; every storage access is guarded, because
 * localStorage throws when cookies are blocked and doesn't exist in the node
 * test environment.
 */
import { create } from "zustand";

/** One toggleable control, in toolbar order. */
export const COMPOSER_CONTROLS = [
  { id: "attach", label: "Attach", hint: "image upload / file path" },
  { id: "dictate", label: "Dictate", hint: "microphone" },
  // One entry, because there is one control: mode and posture both write
  // `chat.modeId`, and showing them as two toggles let you hide the half of a
  // single radio group that says which value is actually set.
  { id: "mode", label: "Mode & posture", hint: "Plan / Auto / Edit · bypass" },
  { id: "effort", label: "Effort", hint: "reasoning depth" },
  { id: "brain", label: "Model / agent", hint: "the session brain" },
  { id: "context", label: "Context meter", hint: "window usage" },
] as const;

export type ComposerControl = (typeof COMPOSER_CONTROLS)[number]["id"];

export type ComposerVisibility = Record<ComposerControl, boolean>;

/** Everything on — the composer as it was before this preference existed. */
export const ALL_VISIBLE: ComposerVisibility = Object.fromEntries(
  COMPOSER_CONTROLS.map((c) => [c.id, true]),
) as ComposerVisibility;

const KEY = "cm:composer-controls";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

/**
 * Tolerant load: an unknown key is ignored and a missing one defaults to
 * visible, so adding a control to the list doesn't hide it for everyone who
 * already saved a preference.
 */
function load(): ComposerVisibility {
  try {
    const raw = backing()?.getItem(KEY);
    if (!raw) return ALL_VISIBLE;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...ALL_VISIBLE };
    for (const c of COMPOSER_CONTROLS) {
      if (typeof parsed[c.id] === "boolean") out[c.id] = parsed[c.id] as boolean;
    }
    return out;
  } catch {
    return ALL_VISIBLE;
  }
}

function persist(v: ComposerVisibility): void {
  try {
    backing()?.setItem(KEY, JSON.stringify(v));
  } catch {
    /* quota / private mode — a lost preference beats a thrown save */
  }
}

interface ComposerPrefsStore {
  visible: ComposerVisibility;
  toggle: (id: ComposerControl) => void;
  showAll: () => void;
}

export const useComposerPrefs = create<ComposerPrefsStore>((set) => ({
  visible: load(),
  toggle: (id) =>
    set((s) => {
      const visible = { ...s.visible, [id]: !s.visible[id] };
      persist(visible);
      return { visible };
    }),
  showAll: () => {
    persist(ALL_VISIBLE);
    return set({ visible: { ...ALL_VISIBLE } });
  },
}));

/** How many controls are currently hidden (drives the toolbar's badge). */
export function hiddenCount(v: ComposerVisibility): number {
  return COMPOSER_CONTROLS.filter((c) => !v[c.id]).length;
}
