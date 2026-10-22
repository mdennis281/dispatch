/**
 * The CLIENT-side plugin API — what a plugin's `client/index.js` receives in
 * `activate(host)`. The browser twin of `plugin-api.ts`; see docs/plugins.md →
 * "Client host".
 *
 * PURE TYPES, like its sibling, so `@dispatch/plugin-sdk` can re-export them.
 * The one dependency is `react`'s type package (a devDependency here): a slot
 * that returns a `ReactNode` has to say so, and `unknown` would make every
 * `render()` a cast in plugin code. The types are erased at build; the server
 * and CLI consume this package's `.d.ts` under `skipLibCheck` and never
 * resolve them.
 *
 * Versioning follows {@link PLUGIN_API_VERSION}: additive within a major.
 */
import type { ComponentType, MouseEvent, ReactNode } from "react";
import type { ChatStatus } from "./common.js";
import type { WsServerEvent, WsServerEventType } from "./wire.js";

/* ------------------------------------------------------------- the chat */

/**
 * A chat as the client host hands it to a plugin — the fields a control,
 * badge or engine actually keys on, not the whole row. `ext` is the per-chat
 * plugin bag (`Chat.ext`), keyed by plugin id; a plugin's own state is
 * `ext[host.pluginId]`.
 */
export interface PluginChatRef {
  id: string;
  projectId: string;
  modeId?: string;
  status?: ChatStatus;
  ext?: Record<string, unknown>;
}

/* ---------------------------------------------------------------- engines */

export interface DictationHandlers {
  /** Stable, committed text. Arrives in chunks as you pause. */
  onFinal(text: string): void;
  /** Live guess for the phrase in progress; replaced on every event. */
  onInterim(text: string): void;
  /** A real problem worth surfacing. Benign codes never reach this. */
  onError(message: string): void;
  /** Recognition has genuinely stopped — update the UI to "not listening". */
  onStopped(): void;
}

export interface DictationEngine {
  start(): void;
  stop(): void;
}

/**
 * A speech-to-text engine a plugin registers. `create` is called once per
 * composer that uses the engine and may return null when it cannot run in
 * this browser; `unavailable` says why up front so the mic control can
 * explain itself rather than failing on press.
 */
export interface DictationEngineDef {
  id: string;
  label: string;
  /** Why the engine cannot run here, or null. Checked before `create`. */
  unavailable?(): string | null;
  create(handlers: DictationHandlers): DictationEngine | null;
}

/**
 * A text-to-speech engine. The host feeds `message-chunk` deltas for the
 * chat on screen as they stream, flushes when the assistant row lands, and
 * cancels when the reader moves on. The host speaks at sentence boundaries:
 * `feed` receives whole sentences, never raw deltas, so an engine is a queue
 * of utterances rather than a tokenizer.
 */
export interface TtsEngine {
  /** Speak this text after whatever is already queued. */
  feed(text: string): void;
  /** Nothing more is coming for this reply; finish what is queued. */
  flush(): void;
  /** Stop now and drop the queue — the reader switched chats or turned it off. */
  cancel(): void;
}

export interface TtsEngineDef {
  id: string;
  label: string;
  unavailable?(): string | null;
  create(): TtsEngine | null;
}

/* ------------------------------------------------------------------ slots */

/**
 * A composer-toolbar control. It enters the size ladder (`COMPOSER_CONTROLS`)
 * with a single `sm` rung at `priority` — the row evicts it like any other
 * icon when width runs out — and gets a root row plus a drill-in in the
 * composer options menu, which is where it lives when evicted. It never adds a
 * row to the composer box.
 */
export interface ComposerControlDef {
  id: string;
  label: string;
  /** Shown beside the label in the options menu, and in the "Show in composer" list. */
  hint: string;
  icon: ReactNode;
  /**
   * Eviction tie-break among icons; lower leaves first. The built-ins run
   * 0 (persona) to 6 (dictate). Default 1, beside the context meter.
   */
  priority?: number;
  /** The toolbar form. Only `sm` exists: a plugin control is an icon. */
  render(size: "sm"): ReactNode;
  /**
   * The options-menu drill-in. Rendered inside the host's menu surface, which
   * on a phone is a bottom sheet — so this must be rows, not a popover (a
   * popover inside the sheet closes the sheet). Omit it and the root row runs
   * `onSelect` instead.
   */
  menu?: ReactNode;
  /** Run when the root row is chosen and there is no `menu`. */
  onSelect?(): void;
}

export interface SettingsSectionDef {
  id: string;
  label: string;
  /** One line under the label in the settings rail — at phone width the rail IS the index. */
  blurb: string;
  icon: ComponentType<{ className?: string }>;
  render(): ReactNode;
}

export interface PanelTabDef {
  id: string;
  label: string;
  /** Which half of the right panel: `ship` (the change) or `run` (the processes). */
  group: "run" | "ship";
  icon?: ReactNode;
  render(chat: PluginChatRef): ReactNode;
}

export interface ChatBadgeDef {
  /** Return null to show nothing for this chat. */
  render(chat: PluginChatRef): ReactNode;
}

/* -------------------------------------------------------------------- kit */

/**
 * The component kit a plugin gets — the subset of `components/ui/` whose
 * props are stable enough to promise, typed by what the HOST guarantees
 * rather than by the host's own prop types (those may grow; these may not
 * shrink). Raw `<button>` is not an option in plugin code any more than in
 * the host — `ui/rawButtons.test.ts` is why the kit exists.
 */
export interface KitButtonProps {
  variant?: "default" | "primary" | "subtle" | "ghost" | "danger" | "link" | "toggle";
  size?: "sm" | "md";
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /** Icon in a circle, no label — for a `primary`/`danger` action in a row with no width. */
  circle?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  className?: string;
  type?: "button" | "submit";
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  children?: ReactNode;
}

export interface KitIconButtonProps {
  size?: "sm" | "md";
  active?: boolean;
  /** Tooltip, and the accessible name. */
  tip?: string;
  disabled?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  children: ReactNode;
}

export interface KitSelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
}

export interface KitSelectProps {
  options: KitSelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  leftIcon?: ReactNode;
  size?: "lg" | "md" | "sm";
  align?: "start" | "end";
  width?: number;
  className?: string;
}

export interface KitMenuItemProps {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  hint?: ReactNode;
  title?: string;
  disabled?: boolean;
  /** Tighter rows, for a pointer menu rather than a touch sheet. */
  dense?: boolean;
  className?: string;
}

export interface KitDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export interface KitTooltipProps {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
  className?: string;
}

export interface KitToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Visible text beside the track; empty renders the track alone. */
  label: string;
  /** The accessible name when `label` is empty. */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface KitFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * A kit entry: callable with the promised props. A plain call signature
 * rather than `ComponentType`, because the host's `forwardRef` components
 * carry a `propTypes` member whose validator types are INVARIANT — a
 * component accepting `type: "reset"` as well cannot be a `ComponentType` of
 * props that do not, even though every call that type-checks here also
 * type-checks there. The call signature is the part that matters, and JSX
 * accepts it.
 */
export type KitComponent<P> = (props: P) => ReactNode;

export interface ClientHostKit {
  Button: KitComponent<KitButtonProps>;
  IconButton: KitComponent<KitIconButtonProps>;
  Select: KitComponent<KitSelectProps>;
  MenuItem: KitComponent<KitMenuItemProps>;
  Dialog: KitComponent<KitDialogProps>;
  Tooltip: KitComponent<KitTooltipProps>;
  Toggle: KitComponent<KitToggleProps>;
  Field: KitComponent<KitFieldProps>;
}

/* ------------------------------------------------------------------- host */

export type ToastKind = "info" | "warn" | "error";

/**
 * What `activate(host)` receives. One object per plugin — `pluginId`,
 * `events.onPlugin` and `api.fetch` are bound to it — and everything it
 * registers returns an unsubscribe.
 */
export interface ClientHost {
  readonly pluginId: string;
  /** The host's React. Plugins never bundle their own; see `window.__dispatch.deps`. */
  readonly React: typeof import("react");
  ui: ClientHostKit;
  slots: {
    composerControl(def: ComposerControlDef): () => void;
    settingsSection(def: SettingsSectionDef): () => void;
    panelTab(def: PanelTabDef): () => void;
    chatBadge(def: ChatBadgeDef): () => void;
  };
  toast(message: string, opts?: { kind?: ToastKind; detail?: string }): void;
  engines: {
    dictation: { register(def: DictationEngineDef): () => void };
    tts: { register(def: TtsEngineDef): () => void };
  };
  events: {
    /** Tap the typed server event stream, after the host's own stores have applied it. */
    on<T extends WsServerEventType>(
      type: T,
      fn: (evt: Extract<WsServerEvent, { type: T }>) => void,
    ): () => void;
    /** This plugin's `plugin-event` payloads only — what its server half `ctx.emit`s. */
    onPlugin(fn: (payload: unknown, chatId?: string) => void): () => void;
  };
  chat: {
    /** The chat on screen, or undefined when none is. */
    current(): PluginChatRef | undefined;
    /**
     * Write this plugin's slice of `chat.ext` — `ext[pluginId] = patch`, or
     * delete it with `null`. Other plugins' keys are untouched; the row comes
     * back on `chat-update`.
     */
    setExt(chatId: string, patch: Record<string, unknown> | null): Promise<void>;
    setMode(chatId: string, modeId: string | null): Promise<void>;
    send(chatId: string, text: string): Promise<void>;
  };
  api: {
    /** `sessionFetch` under `/api/plugins/<pluginId>/` — the plugin's own route table, authenticated. */
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
}

/** What `client/index.js` exports. */
export interface ClientPluginModule {
  activate(host: ClientHost): Promise<void> | void;
}

/**
 * The globals shim. Set on `window.__dispatch` before any plugin bundle
 * loads; the SDK's Vite preset marks these packages external and resolves
 * them here, so React stays a singleton and hooks keep working across the
 * host/plugin boundary.
 */
export interface DispatchClientGlobals {
  deps: {
    react: typeof import("react");
    reactDom: unknown;
    jsxRuntime: unknown;
    zustand: unknown;
    lucide: unknown;
  };
}
