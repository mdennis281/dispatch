/**
 * Which chat-config controls the composer shows, and how big each one may get.
 *
 * The composer toolbar accumulated every per-chat knob there is — mode, posture,
 * effort, model/agent, context meter, dictation, attach — and they are not
 * equally interesting to any one person. Someone who never changes model wants
 * that row quiet; someone tuning effort per turn wants effort visible even on a
 * narrow window. Hiding a control never changes the chat's config, only whether
 * this browser draws it, so the honest fix is a visibility preference rather
 * than a smarter heuristic.
 *
 * Global (not per chat) and stored in localStorage: it's a statement about how
 * you like to work, not about one conversation, and it is genuinely per browser
 * — the phone and the desktop want different rows. The store is a tiny zustand
 * so a toggle re-renders the toolbar; every storage access is guarded, because
 * localStorage throws when cookies are blocked and doesn't exist in the node
 * test environment.
 *
 * SIZE is deliberately NOT persisted. It is derived every render from the row's
 * measured width (see lib/composerFit) — a preference for "effort, large" that
 * a 390px phone cannot honour is a preference that lies, and the same profile
 * has to survive a window drag from 1600px to 400px. What you choose is what
 * appears; how big it gets is the layout's problem.
 */
import { create } from "zustand";

/**
 * The rungs a control descends as the row runs out of room, widest first.
 *
 *   lg   icon + label + chevron — the full control
 *   md   icon + current value   — still readable, ~40% narrower
 *   sm   icon only              — the value moves into the tooltip and the menu
 *   off  not in the row at all  — reachable only through the composer options
 *
 * `off` is the floor for every control, which is what lets the row promise it
 * will never clip Send: when six icons still don't fit, controls leave. Nothing
 * is lost by leaving, because the options menu holds every control at all times
 * whether or not it is in the row.
 */
export const SIZE_RUNGS = ["lg", "md", "sm", "off"] as const;
export type ControlSize = (typeof SIZE_RUNGS)[number];

/** Position on the ladder — bigger number, smaller control. */
export function rungCost(size: ControlSize): number {
  return SIZE_RUNGS.indexOf(size);
}

interface ControlDef {
  id: string;
  label: string;
  hint: string;
  /**
   * The sizes this control actually has, widest first. Every control has `sm`
   * (an icon that opens its own menu) — that is the contract the fitting
   * algorithm relies on. Not every control has more: Attach and Dictate have no
   * VALUE to display, so a labelled form would just be a wider icon, and the
   * context meter's `md` form (bar + token count) is already its full self.
   */
  sizes: readonly ControlSize[];
  /**
   * Tie-break when several controls are equally shrunken: the lowest priority
   * gives up its slot first. Only consulted between controls at the same rung —
   * a large control always shrinks before a small one is evicted.
   */
  priority: number;
}

/** One toggleable control, in toolbar order. */
export const COMPOSER_CONTROLS = [
  { id: "attach", label: "Attach", hint: "image upload / file path", sizes: ["sm"], priority: 2 },
  // Dictate outranks everything for eviction: press-and-hold is the one gesture
  // that cannot move into a menu (a sheet closes on selection), and a mic is a
  // better control on a phone than it has ever been on a desktop.
  { id: "dictate", label: "Dictate", hint: "microphone", sizes: ["sm"], priority: 6 },
  // One entry, because there is one control: mode and posture both write
  // `chat.modeId`, and showing them as two toggles let you hide the half of a
  // single radio group that says which value is actually set.
  {
    id: "mode",
    label: "Mode & posture",
    hint: "Plan / Auto / Edit · bypass",
    sizes: ["lg", "md", "sm"],
    priority: 5,
  },
  {
    id: "effort",
    label: "Effort",
    hint: "reasoning depth",
    sizes: ["lg", "md", "sm"],
    priority: 3,
  },
  {
    id: "brain",
    label: "Model / agent",
    hint: "the session brain",
    sizes: ["lg", "md", "sm"],
    priority: 4,
  },
  { id: "context", label: "Context meter", hint: "window usage", sizes: ["md", "sm"], priority: 1 },
] as const satisfies readonly ControlDef[];

export type ComposerControl = (typeof COMPOSER_CONTROLS)[number]["id"];

export type ComposerVisibility = Record<ComposerControl, boolean>;

/**
 * The rungs this control has, widest first. Widened from the `as const` tuple:
 * the literal type of `sizes` is per-control (`readonly ["sm"]` for attach), and
 * the fitting algorithm walks all of them through one uniform ladder.
 */
export function ladderOf(id: ComposerControl): readonly ControlSize[] {
  return COMPOSER_CONTROLS.find((c) => c.id === id)!.sizes;
}

/** Widest rung this control has — where it starts before any shrinking. */
export function widestSize(id: ComposerControl): ControlSize {
  return ladderOf(id)[0]!;
}

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
