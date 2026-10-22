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
 *
 * The list is a REGISTRY, not only the `as const` array below: a plugin's
 * composer control (`host.slots.composerControl`) is appended at runtime with
 * a single `sm` rung and the priority it asked for, and from then on it is
 * one more control the ladder shrinks and evicts like any other. That is the
 * rule from the persona-row incident — a per-chat control competes for THIS
 * row, it never gets a row of its own — applied to code the repo cannot see.
 */
import type { ReactNode } from "react";
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

export interface ControlDef {
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

/** One toggleable built-in control, in toolbar order. */
export const COMPOSER_CONTROLS = [
  { id: "attach", label: "Attach", hint: "upload files / insert a path", sizes: ["sm"], priority: 2 },
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
    label: "Model",
    hint: "provider · account · model",
    sizes: ["lg", "md", "sm"],
    priority: 4,
  },
  // Persona is set once per chat and off by default, so it is the first to
  // shrink and the first to leave. `md` is the persona's name; with none set it
  // draws as its icon even at `md`, so an off persona never spends a label.
  { id: "persona", label: "Persona", hint: "chat role", sizes: ["md", "sm"], priority: 0 },
  { id: "context", label: "Context meter", hint: "window usage", sizes: ["md", "sm"], priority: 1 },
] as const satisfies readonly ControlDef[];

export type BuiltinComposerControl = (typeof COMPOSER_CONTROLS)[number]["id"];

/**
 * A control id: one of the built-ins, or whatever a plugin registered. The
 * `string & {}` keeps the built-in literals in completions while admitting
 * runtime ids the type cannot know.
 */
export type ComposerControl = BuiltinComposerControl | (string & {});

/**
 * Visibility per control. Built-ins are always present; runtime controls are
 * keyed by their registered id and added (default visible) the moment they
 * register, so a read for a registered control never finds a hole.
 */
export type ComposerVisibility = Record<BuiltinComposerControl, boolean> & Record<string, boolean>;

/* ------------------------------------------------------- runtime registry */

/**
 * A control registered at runtime — the host's `ComposerControlDef` with the
 * ladder entry filled in. `sizes` is always `["sm"]`: a plugin control is an
 * icon that opens its own menu, the one shape every control already has.
 */
export interface RuntimeControlDef extends ControlDef {
  sizes: readonly ["sm"];
  /** The plugin that registered it — what the slot's error boundary names. */
  owner?: string;
  icon: ReactNode;
  render(size: "sm"): ReactNode;
  menu?: ReactNode;
  onSelect?(): void;
}

interface ComposerRegistryStore {
  runtime: RuntimeControlDef[];
}

/** Runtime controls, in registration order. Subscribed by the composer so a late registration re-renders it. */
export const useComposerRegistry = create<ComposerRegistryStore>(() => ({ runtime: [] }));

/**
 * Append a runtime control to the ladder. Returns the unregister. Refuses an
 * id that is already taken — a second "attach" would make `sizes.attach`
 * ambiguous, and two plugins colliding is a bug worth a toast rather than a
 * silent last-writer-wins.
 */
export function registerComposerControl(def: Omit<RuntimeControlDef, "sizes">): () => void {
  if (allControls().some((c) => c.id === def.id)) {
    throw new Error(`composer control "${def.id}" is already registered`);
  }
  const entry: RuntimeControlDef = { ...def, sizes: ["sm"] };
  useComposerRegistry.setState((s) => ({ runtime: [...s.runtime, entry] }));
  useComposerPrefs.getState().ensure(def.id);
  return () => {
    useComposerRegistry.setState((s) => ({ runtime: s.runtime.filter((c) => c !== entry) }));
  };
}

/** Every control the ladder currently knows: the built-ins, then the runtime ones. */
export function allControls(): readonly ControlDef[] {
  const runtime = useComposerRegistry.getState().runtime;
  return runtime.length ? [...COMPOSER_CONTROLS, ...runtime] : COMPOSER_CONTROLS;
}

/* ----------------------------------------------------------------- ladder */

/**
 * The rungs this control has, widest first. Widened from the `as const` tuple:
 * the literal type of `sizes` is per-control (`readonly ["sm"]` for attach), and
 * the fitting algorithm walks all of them through one uniform ladder. An id the
 * registry no longer knows (a plugin's control after it unregistered, still in
 * a stale sizes map) gets the universal floor, `["sm"]`.
 */
export function ladderOf(id: ComposerControl): readonly ControlSize[] {
  return allControls().find((c) => c.id === id)?.sizes ?? ["sm"];
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
 * Tolerant load: a missing key defaults to visible, so adding a control to
 * the list doesn't hide it for everyone who already saved a preference. Keys
 * the built-in list does not know are KEPT when they are booleans: they are
 * plugin controls, saved before this load and registered after it.
 */
function load(): ComposerVisibility {
  try {
    const raw = backing()?.getItem(KEY);
    if (!raw) return ALL_VISIBLE;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ComposerVisibility = { ...ALL_VISIBLE };
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") out[id] = value;
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
  /** Make sure a (runtime) control has an entry — default visible — without touching one that exists. */
  ensure: (id: ComposerControl) => void;
}

export const useComposerPrefs = create<ComposerPrefsStore>((set) => ({
  visible: load(),
  toggle: (id) =>
    set((s) => {
      const visible = { ...s.visible, [id]: !(s.visible[id] ?? true) };
      persist(visible);
      return { visible };
    }),
  showAll: () =>
    set((s) => {
      const visible = { ...s.visible };
      for (const c of allControls()) visible[c.id] = true;
      persist(visible);
      return { visible };
    }),
  ensure: (id) =>
    set((s) => {
      if (typeof s.visible[id] === "boolean") return {};
      return { visible: { ...s.visible, [id]: true } };
    }),
}));

/** How many controls are currently hidden (drives the toolbar's badge). */
export function hiddenCount(v: ComposerVisibility): number {
  return allControls().filter((c) => !(v[c.id] ?? true)).length;
}
