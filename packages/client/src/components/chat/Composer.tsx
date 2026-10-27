import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import { flushSync } from "react-dom";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Paperclip,
  ArrowUp,
  Bot,
  Pencil,
  Layers,
  X,
  SlidersHorizontal,
  Settings2,
  Eye,
  Check,
  ChevronLeft,
  ChevronRight,
  Cpu,
  ChevronsUpDown,
  Gauge,
  Square,
  File as FileIcon,
  FileCode2,
  Mic,
  Drama,
  KeyRound,
  RotateCcw,
  Volume2,
  AudioLines,
  TriangleAlert,
} from "lucide-react";
import type { Chat, Effort, AgentConfig, ModeConfig, ImageRef, HarnessKind } from "@dispatch/shared";
import {
  isGlobalProject,
  accountLabel,
  chatAccountOf,
  defaultModelFor,
  findModel,
  chatRoot,
  providerFor,
  mediaKind,
  type SubscriptionStatus,
} from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { postureSourceShort, useChatPosture } from "../../lib/chatPosture.js";
import { pathsFromDrop, dropIntent, type DropIntent } from "../../lib/dropPaths.js";
import { useFileDrag } from "../../lib/useFileDrag.js";
import { useDictation, PTT_LABEL } from "../../lib/useDictation.js";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  appendDraftImage,
} from "../../lib/composerDrafts.js";
import { pickPath } from "../files/filePicker.js";
import { SlashMenu } from "./SlashMenu.js";
import { useSlashCommands, slashKeyAction } from "./useSlashCommands.js";
import { fsToNative } from "../files/fsMeta.js";
import { useFsRoots } from "../../stores/fsRoots.js";
import { useProjects } from "../../stores/projects.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { RowButton } from "../ui/RowButton.js";
import { Select, type SelectInherit, type SelectOption } from "../ui/Select.js";
import { EffortGauge } from "../ui/EffortGauge.js";
import { Chip } from "../ui/Chip.js";
import { Tooltip } from "../ui/Tooltip.js";
import { Spinner } from "../ui/Spinner.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { cn } from "../../lib/cn.js";
import { composerPlaceholder, isTouchPrimary } from "../../lib/submitHint.js";
import {
  DEFAULT_SEND_MODE,
  SEND_MODE_LABEL,
  sendModeFromKey,
  sendModeKeyHint,
  type SendMode,
} from "../../lib/sendMode.js";
import { SendModeMenu, SEND_MODE_ICON } from "./SendModeMenu.js";
import { useSettings } from "../../stores/settings.js";
import { useAttention } from "../../stores/attention.js";
import { focusAttentionItem } from "../attention/focus.js";
import { blockingQuestion, composerDeferred, isDoubleTap } from "../../lib/composerDefer.js";
import { useChats } from "../../stores/chats.js";
import { useModels } from "../../stores/models.js";
import { useHarnesses } from "../../stores/harnesses.js";
import {
  useAvailableProviders,
  useProviderAvailability,
  useRecheckWhileLoggedOut,
} from "../../lib/providerAvailability.js";
import { useSubscriptions } from "../../stores/subscriptions.js";
import { useLayoutMode } from "../../stores/layout.js";
import { Drawer } from "../layout/Drawer.js";
import { actions, uploadChatImage } from "../../lib/actions.js";
import { useAssetSrc } from "../../lib/assetSrc.js";
import { AssetImage } from "../ui/AssetImage.js";
import { useEffectiveEffort } from "../../lib/effectiveEffort.js";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import {
  allControls,
  hiddenCount,
  useComposerPrefs,
  useComposerRegistry,
  type ComposerControl,
} from "../../lib/composerPrefs.js";
import { useEngines, activeTtsEngine } from "../../lib/engines.js";
import { PluginSlot } from "../../plugins/PluginSlot.js";
import { SlotErrorBoundary } from "../ErrorBoundary.js";
import {
  demote,
  promote,
  reconcile,
  widestSizes,
  evictedCount,
  type ComposerSizes,
} from "../../lib/composerFit.js";
import { EffortChip } from "../agents/runVisuals.js";
import { ContextMeter, ContextHint, ContextPanelBody } from "./ContextMeter.js";
import { usePersonaPicker, PersonaRows, PersonaConfigureDialog } from "./PersonaControl.js";
import { ModeControl, ModeMenu, modeLabel, modeIcon } from "./ModeControl.js";

/** The markup editor pulls in two annotation engines — lazy so they stay out of
    the initial bundle and only load when a thumbnail is actually opened. */
const ImageAnnotator = lazy(() => import("./ImageAnnotator.js"));

/**
 * Remembers the model picked per chat for this browser session — a fast optimistic
 * layer over the persisted `chat.model`, so the selector reflects the user's choice
 * instantly across chat switches (local state only re-seeds on a `chat.id` change).
 */
const modelByChat = new Map<string, string>();

export interface ComposerProps {
  chat: Chat;
  agents: AgentConfig[];
  modes: ModeConfig[];
}

/**
 * Every uploadable File in a paste/drop, and how many FOLDERS were skipped.
 *
 * A dropped folder arrives as a File too — zero bytes, no type — and reading it
 * fails deep inside the upload with an error that names nothing. Only the entry
 * API can tell the two apart, and only during the drop event itself.
 */
function filesFrom(dt: DataTransfer | null | undefined): { files: File[]; folders: number } {
  if (!dt) return { files: [], folders: 0 };
  const files: File[] = [];
  let folders = 0;
  const items = dt.items ? Array.from(dt.items).filter((it) => it.kind === "file") : [];
  if (items.length) {
    for (const it of items) {
      if (it.webkitGetAsEntry?.()?.isDirectory) {
        folders++;
        continue;
      }
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  } else if (dt.files?.length) {
    files.push(...Array.from(dt.files));
  }
  return { files, folders };
}

/**
 * What the drop overlay promises, per outcome. Phrased as the result the user
 * gets, not the mechanism: "insert its path" is checkable against what lands in
 * the box a moment later, "read via webUtils" is not.
 */
const DROP_COPY: Record<Exclude<DropIntent, null>, { icon: ReactNode; title: string; hint: string }> =
  {
    upload: {
      icon: <Paperclip />,
      title: "Drop to attach",
      hint: "the file is uploaded and sent with your message",
    },
    path: {
      icon: <FileCode2 />,
      title: "Drop to insert the file path",
      hint: "The agent reads the file itself — nothing is uploaded",
    },
  };

/**
 * The mid-drag overlay. Covers the composer so the promise is unmissable, and
 * is `pointer-events-none` so it can't eat the drop it's advertising or bounce
 * the dragleave/dragenter pair underneath it.
 */
function DropOverlay({ intent, armed }: { intent: Exclude<DropIntent, null>; armed: boolean }) {
  const copy = DROP_COPY[intent];
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 rounded-lg",
        "border-2 border-dashed transition-colors duration-150",
        armed
          ? "border-accent bg-panel-2/95"
          : "border-accent-line bg-panel-2/80",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-base font-medium transition-colors",
          armed ? "text-accent-hi" : "text-secondary",
          "[&_svg]:size-4",
        )}
      >
        {copy.icon}
        {copy.title}
      </div>
      <div className="px-4 text-center text-xs text-faint">{copy.hint}</div>
    </div>
  );
}

/**
 * Turn pasted rich HTML into literal text for this plain-text composer. Hyperlinks
 * become markdown `[label](url)` — but only when the label differs from the bare URL,
 * so pasting a plain link stays a plain link rather than `[url](url)`. `<br>` and
 * block boundaries become newlines; everything else collapses to its text. The
 * markdown is kept literal on purpose: it's only interpreted when the message is
 * rendered, after send — never live in the box.
 */
function richPasteToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href")?.trim() ?? "";
    const label = (a.textContent ?? "").trim();
    const linkable = /^(https?:|mailto:)/i.test(href);
    a.replaceWith(
      doc.createTextNode(linkable && label && label !== href ? `[${label}](${href})` : href || label),
    );
  });
  doc.querySelectorAll("br").forEach((br) => br.replaceWith(doc.createTextNode("\n")));
  // A block element implies a line break between its text and whatever follows.
  doc
    .querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote")
    .forEach((el) => el.append(doc.createTextNode("\n")));
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

const filenameOf = (img: ImageRef) => img.path.split(/[\\/]/).pop() ?? "image";

/**
 * An attachment the agent READS rather than sees. Same rule as the server's
 * `splitAttachments`: a ref with no type is an image, because every one written
 * before files could be uploaded was.
 */
const isFileRef = (ref: ImageRef) => !!ref.mimeType && mediaKind(ref.mimeType) !== "image";

/** "PDF", "MD", … — the extension says more at a glance than `application/octet-stream`. */
const fileTypeLabel = (ref: ImageRef) => {
  const name = ref.alt ?? filenameOf(ref);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "file";
};

/**
 * True when the caret already sits in some other text field — a rename box, a
 * dialog, the command palette. Opening a chat auto-focuses the composer, and
 * that must never yank the cursor out from under someone mid-typing.
 */
function typingElsewhere(editorDom: Element): boolean {
  const el = document.activeElement;
  if (!el || el === document.body || editorDom.contains(el)) return false;
  return (
    (el as HTMLElement).isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/**
 * The header of a drilled-into options page. Shared by the popover and the
 * sheet, which differ only in row height — the popover is aimed with a pointer,
 * the sheet with a thumb.
 */
function ConfigBackRow({
  title,
  dense,
  onBack,
}: {
  title: string;
  dense: boolean;
  onBack: () => void;
}) {
  return (
    <div className="mb-1 flex items-center gap-1 border-b border-line-soft pb-1.5">
      <Button
        variant="ghost"
        onClick={onBack}
        leftIcon={<ChevronLeft />}
        className={dense ? "h-7 px-1.5 text-sm" : "h-11 px-2 text-base"}
      >
        Back
      </Button>
      <span className={cn("font-medium text-primary", dense ? "text-sm" : "text-base")}>
        {title}
      </span>
    </div>
  );
}

/**
 * Which page the composer-options surface is showing. `root` is a plain list of
 * every control — the menu is the one place that always has all of them, whether
 * or not the toolbar had room — and each of the others is one control's own menu
 * drilled into IN PLACE. `customize` is where you choose what the toolbar tries
 * to show, nested a level down because it is a setting, not a thing you reach
 * for mid-turn.
 */
type ConfigView = "root" | ComposerControl | "customize" | "voice";

/** The chat composer: TipTap input + attachments + effort/mode/agent + send/steer. */
export function Composer({ chat, agents, modes }: ComposerProps) {
  const upsertChat = useChats((s) => s.upsertChat);
  // Exactly the row's provider — no default fills an absent one in (#426).
  const harness = chat.harness;
  // Why this chat cannot run right now, if it can't: its provider plugin is off,
  // its CLI is missing, or it names none. Derived from the live provider list,
  // so the banner below clears by itself the moment the provider comes back.
  //
  // Judged by the chat's OWN account's login (see `chatAccountOf` below), as
  // the broker judges it — not the default account's, which would block a chat
  // pinned to a second, working login. Until the account list loads there is
  // no login to judge by, and the server still refuses a send if it must.
  const chatAccount = useSubscriptions((s) => (harness ? chatAccountOf(s.list, chat, harness) : undefined));
  const unavailable = useProviderAvailability(harness, chatAccount ?? null);
  useRecheckWhileLoggedOut(unavailable);
  const switchable = useAvailableProviders();
  // What this chat RUNS as. `chat.effort` / `chat.modeId` / `chat.model` are
  // pins and may be absent; the resolved values below are what every control
  // displays, and each carries where it came from for the inherit rows.
  const posture = useChatPosture(chat.id);
  const effort = posture.effort.effective;
  const modeId = posture.modeId.effective;
  const harnesses = useHarnesses((s) => s.harnesses);
  const capabilities = harnesses.find((h) => h.kind === harness)?.capabilities;

  // Attachments come back from the saved draft (see lib/composerDrafts), so a
  // reload or a chat switch keeps them exactly as the text does.
  const [attachments, setAttachments] = useState<ImageRef[]>(() => loadDraft(chat.id).images);
  const [editing, setEditing] = useState<ImageRef | null>(null);
  // The annotator takes a URL, so the asset has to be resolved to a renderable
  // one first — the raw endpoint is bearer-authenticated (see lib/assetSrc.ts).
  const editingSrc = useAssetSrc(chat.id, editing).src;
  const [uploading, setUploading] = useState(0);
  // Queued/steering count is server truth (chat-status.queued): it clears the
  // instant the agent consumes the message, not only when the whole turn ends.
  const queued = useChats((s) => s.queued[chat.id] ?? 0);
  // Sends deliberately WITHHELD until this turn ends (a Queue, or the fresh-turn
  // half of an Interrupt). Server truth for the same reason `queued` is, and a
  // separate number because it means the opposite thing: the agent cannot have
  // seen these yet.
  const pending = useChats((s) => s.pending[chat.id] ?? 0);
  // What Ctrl/⌘↵ and the Send button DO to a turn in flight. App-wide, pinned
  // from the dropup beside Send (there is no Settings row for it).
  const appSendMode = useSettings((s) => s.app.defaultSendMode) ?? DEFAULT_SEND_MODE;
  const applySettings = useSettings((s) => s.apply);
  const pinDefaultSendMode = useSettings((s) => s.setDefaultSendMode);
  const [isEmpty, setIsEmpty] = useState(true);
  // Two scopes of drag state. `fileDrag` is the whole window — it lights the
  // composer up the moment a file crosses the app, so the user sees where to
  // aim. `over` is this box specifically, which upgrades the same affordance to
  // "release now".
  const fileDrag = useFileDrag();
  const [over, setOver] = useState<DropIntent>(null);
  const [error, setError] = useState<string | null>(null);
  const persona = usePersonaPicker(chat);
  // The login account this chat runs under. It is picked inside the model menu,
  // nested under its provider row: an account belongs to exactly one provider,
  // and a separate toolbar control for it duplicated the provider switch (an
  // account on another provider moves the chat there anyway).
  const accounts = useSubscriptions((s) => s.list);
  const account = harness ? chatAccountOf(accounts, chat, harness) : undefined;
  const accountName = account ? accountLabel(account) : undefined;
  // Which provider's accounts the model menu has drilled into, if any. Swapped
  // IN PLACE for the same reason `moreView` is — never a popover in a popover.
  const [brainProvider, setBrainProvider] = useState<SubscriptionStatus["provider"] | null>(null);
  // Where the file picker opens: this chat's own working directory, so the
  // paths it inserts are paths the agent for THIS chat can open.
  //
  // The project record can be missing for a moment (first hydration, a
  // reconnect), and falling straight through to the picker's default would land
  // you in the server's HOME directory — the one place this is guaranteed not
  // to mean. `chat.worktrees[0]` is the half of `chatRoot` that lives on the
  // chat itself, so a chat with a worktree still opens correctly regardless;
  // only a chat with no worktree AND no loaded project is left to the default.
  const project = useProjects((s) => s.projects.find((p) => p.id === chat.projectId));
  const pickerRoot = project ? chatRoot(chat, project) : chat.worktrees[0];
  const [model, setModelState] = useState<string>(
    () =>
      modelByChat.get(chat.id) ??
      posture.model.effective ??
      (harness ? defaultModelFor(harness) : undefined) ??
      "",
  );
  // Selectable models come from the server (the live Claude Code runtime list,
  // or a static fallback), seeded so the picker is never empty. `findModel`
  // resolves a pinned id through aliases — a chat saved as "claude-opus-4-8"
  // still selects the runtime's "opus[1m]" row — and a genuinely unknown id
  // falls back to labelling with its raw string.
  const models = useModels((s) => s.models);
  const effortOptions = capabilities?.efforts?.length
    ? EFFORT_OPTIONS.filter((o) => capabilities.efforts.includes(o.value))
    : EFFORT_OPTIONS;
  const modelLabelOf = (m: string) =>
    (m ? findModel(models, m)?.label ?? m : models[0]?.label) ?? "Provider default";
  // The row the picker should mark as selected: matched by identity, since
  // several rows can resolve to the same underlying model.
  const selectedModel = chat.agentId ? undefined : findModel(models, model);

  useEffect(() => {
    // No provider, no catalogue — the picker empties rather than keeping the
    // previous chat's list, whose ids this chat could never send.
    if (!harness) {
      useModels.getState().setModels([], undefined);
      return;
    }
    const cached = useModels.getState().byHarness[harness];
    if (cached?.length) useModels.getState().setModels(cached, harness);
    void api.models
      .list(harness)
      .then((next) => useModels.getState().setModels(next, harness))
      .catch(() => {});
  }, [harness]);
  // What the main loop is REALLY thinking at, off the transcript's newest
  // main-loop row (the picker below only knows what was asked for).
  const effectiveEffort = useEffectiveEffort(chat.id);
  // Which chat-config controls this browser draws. Hiding one never changes the
  // chat — the mode/effort/model still apply — it just stops competing for the
  // toolbar's width (see lib/composerPrefs).
  const visible = useComposerPrefs((s) => s.visible);
  const toggleControl = useComposerPrefs((s) => s.toggle);
  const showAllControls = useComposerPrefs((s) => s.showAll);
  // Plugin controls (host.slots.composerControl). Subscribed so a plugin that
  // activates after this composer mounted appears without a remount, and so
  // `allControls()` below — which reads the same registry — is re-run.
  const runtimeControls = useComposerRegistry((s) => s.runtime);
  // Voice: which engines exist, which are picked, and whether replies are
  // read aloud. All per browser (lib/engines), all surfaced in the options
  // menu below — never as a row of their own in the box.
  const speakReplies = useEngines((s) => s.speakReplies);
  const setSpeakReplies = useEngines((s) => s.setSpeakReplies);
  const dictationEngines = useEngines((s) => s.dictation);
  const ttsEngines = useEngines((s) => s.tts);
  const dictationId = useEngines((s) => s.dictationId);
  const ttsId = useEngines((s) => s.ttsId);
  const selectDictation = useEngines((s) => s.selectDictation);
  const selectTts = useEngines((s) => s.selectTts);
  const ttsLabel = activeTtsEngine({ tts: ttsEngines, ttsId }).label;
  const hidden = hiddenCount(visible);
  // How big each control is currently drawn — derived from measurement, never
  // stored. Starts at everything's widest and gets walked down by `fit` below.
  const [sizes, setSizes] = useState<ComposerSizes>(() => widestSizes(visible));
  const evicted = evictedCount(sizes, visible);
  // Phone still matters, but only for TOUCH now: taller boxes, roomier menu
  // rows, a circular Send. Which controls the row carries is decided by the
  // same measurement at every width — a phone simply ends up with icons,
  // because icons are what fits.
  const phone = useLayoutMode() === "sm";
  const [moreOpen, setMoreOpen] = useState(false);
  // The options surface is ONE surface that swaps its own content, never a
  // popover inside a popover: the inner one portals to `document.body`, which
  // the outer's outside-click test reads as "outside" (see ui/Popover). That is
  // true of the desktop popover as much as the phone sheet, so both drill.
  const [moreView, setMoreView] = useState<ConfigView>("root");
  const toolbarRef = useRef<HTMLDivElement>(null);
  // The row width at which the CURRENT layout was last seen to overflow. Growing
  // a control back is only retried once the row is meaningfully wider than that,
  // which is the hysteresis that stops the two states flip-flopping on the
  // boundary pixel.
  const blockedWidthRef = useRef(0);
  // `step` is memoized with no deps (the ResizeObserver must not be torn down and
  // rebuilt on every preference change), so it reads visibility through a ref.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Latest submit/upload closures, so the (once-configured) TipTap key/paste
  // handlers always call through to fresh state.
  const submitRef = useRef<(mode?: SendMode) => void>(() => {});
  const addFilesRef = useRef<(files: File[]) => void>(() => {});
  // Drop handling (images → upload, everything else → a path), reached through a
  // ref for the same reason: TipTap's handler is configured once.
  const handleDropRef = useRef<(dt: DataTransfer | null) => boolean>(() => false);
  // Insert already-converted rich-paste text (markdown links + newlines) as literal
  // text — no HTML re-parsing, so `[label](url)` and `&`/`<` stay verbatim.
  const insertRichRef = useRef<(text: string) => void>(() => {});
  // Dictated text, reached through a ref because the mic is wired up before the
  // editor exists — see the `useDictation` call just below.
  const insertSpokenRef = useRef<(text: string) => void>(() => {});
  // The `/` menu, reached from TipTap's once-configured handlers for the same
  // reason as the others. `keys` returns true when the menu consumed the event,
  // which is what stops Enter from sending the half-typed command name.
  const slashKeyRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const slashTextRef = useRef<(text: string) => void>(() => {});
  // The once-configured `onUpdate` closure can't see the current `chat.id`, so it
  // reads it through this ref (kept in sync every render) to key the saved draft.
  const chatIdRef = useRef(chat.id);
  chatIdRef.current = chat.id;
  // Mirror of `attachments` for the same reason, and so an in-flight upload can
  // append to the list it actually observed rather than a stale render's copy.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // Declared up here, ahead of the editor, so the chat-switch effect below can
  // close the mic. The insertion callback goes through a ref for the same reason.
  const dictation = useDictation(
    useCallback((text: string) => insertSpokenRef.current(text), []),
  );

  const running = chat.status === "running" || chat.status === "waiting";
  // TipTap's `handleKeyDown` is configured ONCE, so the send-mode chords read
  // both of their inputs through refs — the same arrangement as `submitRef` and
  // the slash menu just above.
  const runningRef = useRef(running);
  runningRef.current = running;
  const appSendModeRef = useRef(appSendMode);
  appSendModeRef.current = appSendMode;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      Placeholder.configure({ placeholder: composerPlaceholder() }),
    ],
    content: "",
    // The composer is plain text: what you type is what you send, verbatim. Input
    // rules ("1. " → list, "# " → heading, "**x**" → bold) and paste rules would
    // silently rewrite typed markdown into rich nodes that `getText` then strips —
    // so we turn both off and let the message renderer interpret the markdown after
    // send instead.
    enableInputRules: false,
    enablePasteRules: false,
    onUpdate: ({ editor }) => {
      setIsEmpty(editor.isEmpty);
      slashTextRef.current(editor.getText());
      // Persist the live draft so it survives a chat switch, an unmount, and a
      // reload. Attachments ride along: a text-only edit must not drop them.
      saveDraft(chatIdRef.current, {
        html: editor.isEmpty ? "" : editor.getHTML(),
        images: attachmentsRef.current,
      });
    },
    editorProps: {
      attributes: { class: "cm-scroll max-h-52 overflow-y-auto" },
      handleKeyDown: (_view, event) => {
        // The menu gets first refusal on the navigation keys. It only claims
        // them while it is open with matches, so nothing here is swallowed the
        // rest of the time.
        if (slashKeyRef.current(event)) {
          event.preventDefault();
          return true;
        }
        // Which of the three mid-turn behaviours this chord asks for — or null,
        // which is how bare ⇧↵ keeps inserting a newline on an idle chat. See
        // lib/sendMode.
        const mode = sendModeFromKey(event, {
          running: runningRef.current,
          appDefault: appSendModeRef.current,
        });
        if (mode) {
          event.preventDefault();
          submitRef.current(mode);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const clip = (event as ClipboardEvent).clipboardData;
        // A file copied in Explorer/Finder pastes as a File, same as a screenshot.
        const { files } = filesFrom(clip);
        if (files.length) {
          addFilesRef.current(files);
          return true;
        }
        // Rich text with links (e.g. a hyperlink copied from a page) → insert the
        // markdown `[label](url)` form as literal text. Plain-text pastes fall
        // through to the default handler so multi-line text is preserved.
        const html = clip?.getData("text/html");
        if (html && /<a\b/i.test(html)) {
          const text = richPasteToText(html);
          if (text) {
            insertRichRef.current(text);
            return true;
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const e = event as DragEvent;
        if (!handleDropRef.current(e.dataTransfer)) return false;
        e.preventDefault();
        // The composer shell is also a drop target (it covers the toolbar and
        // padding, which the editor doesn't). Stop here so a drop that lands on
        // the text area isn't then handled a second time on the way up.
        e.stopPropagation();
        return true;
      },
    },
  });

  // Reset the composer when switching chats — but rehydrate the incoming chat's
  // unsent draft (text AND attachments) instead of clearing, so neither a
  // half-typed message nor a pasted screenshot is lost.
  useEffect(() => {
    if (!editor) return;
    // A mic left open across a switch would type into the chat you just left.
    dictation.stop();
    const saved = loadDraft(chat.id);
    // `preserveWhitespace: "full"`, because the default DOM parse eats a
    // TRAILING space — and a draft holding a picked `/command ` depends on that
    // space: without it, restoring the draft and typing the first argument
    // character produces `/commandx`. Faithful either way; a draft should come
    // back as the text that was saved.
    editor.commands.setContent(saved.html, false, { preserveWhitespace: "full" });
    attachmentsRef.current = saved.images;
    setAttachments(saved.images);
    setEditing(null);
    setUploading(0);
    setError(null);
    setIsEmpty(editor.isEmpty);
    setModelState(
      modelByChat.get(chat.id) ??
        posture.model.effective ??
        (harness ? defaultModelFor(harness) : undefined) ??
        "",
    );

    // Land the caret in the composer so an opened chat — brand new, picked from
    // the sidebar, or jumped to from the palette — is typeable immediately. Every
    // open path ends at a `chat.id` change here (or a remount coming back from the
    // git/memory views), so this one effect covers them all. Deferred a frame so
    // the focus lands after the click that opened the chat has settled, and after
    // `setContent` above, which is what makes "end" the end of the restored draft.
    // ...but NOT on touch, where "typeable immediately" is the wrong default:
    // you open a chat to READ it, and a caret landing in the composer either
    // throws the keyboard over half the transcript or — because iOS refuses a
    // programmatic focus that no gesture asked for — raises no keyboard at all
    // while still firing `focusin`, which stood the bottom nav down and left it
    // down until the next tap elsewhere. Tapping the composer still focuses it.
    if (matchMedia("(pointer: coarse)").matches) return;

    const raf = requestAnimationFrame(() => {
      if (editor.isDestroyed || typingElsewhere(editor.view.dom)) return;
      editor.commands.focus("end");
    });
    return () => cancelAnimationFrame(raf);
  }, [chat.id, editor, dictation.stop]);

  /** Replace the attachment list and persist it alongside the current text. */
  const putAttachments = (next: ImageRef[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
    saveDraft(chatIdRef.current, {
      html: !editor || editor.isEmpty ? "" : editor.getHTML(),
      images: next,
    });
  };

  const addFiles = async (imgs: File[]) => {
    if (!imgs.length) return;
    // Uploads outlive a chat switch. Bind everything to the chat that owns them
    // so a slow upload can't land its image — or its spinner — in whichever chat
    // the user happens to be looking at when it finishes.
    const forChat = chat.id;
    setError(null);
    setUploading((n) => n + imgs.length);
    for (const f of imgs) {
      const stillHere = () => chatIdRef.current === forChat;
      try {
        const ref = await uploadChatImage(forChat, f);
        if (stillHere()) putAttachments([...attachmentsRef.current, ref]);
        else appendDraftImage(forChat, ref); // waiting when they switch back
      } catch (e) {
        if (stillHere()) {
          const why = e instanceof Error ? e.message : "upload failed";
          setError(`Couldn't attach ${f.name || "file"}: ${why}`);
        }
      } finally {
        if (stillHere()) setUploading((n) => n - 1);
      }
    }
  };
  addFilesRef.current = addFiles;

  /** Insert literal text at the cursor, newlines becoming hard breaks. */
  const insertText = (text: string) => {
    const content: JSONContent[] = [];
    text.split("\n").forEach((part, i) => {
      if (i > 0) content.push({ type: "hardBreak" });
      if (part) content.push({ type: "text", text: part });
    });
    if (content.length) editor?.commands.insertContent(content);
  };
  insertRichRef.current = insertText;

  /**
   * Insert a dictated phrase at the cursor. Speech arrives as bare phrases with
   * no spacing of its own, so we supply the join: a space before it unless the
   * draft is empty or already ends in whitespace, and a trailing space so the
   * next phrase — spoken or typed — doesn't run into this one.
   */
  const insertSpoken = (text: string) => {
    if (!editor) return;
    const before = editor.state.doc.textBetween(0, editor.state.selection.from, "\n", " ");
    insertText(before && !/\s$/.test(before) ? ` ${text} ` : `${text} `);
  };
  insertSpokenRef.current = insertSpoken;

  /**
   * Drop file paths into the message as text. One per line, with a trailing
   * space so the cursor lands ready for the sentence that follows — the path is
   * almost never the last thing someone types.
   */
  const insertPaths = (paths: string[]) => {
    if (!paths.length) return;
    insertText(`${paths.join("\n")} `);
    editor?.commands.focus();
  };

  /**
   * Browse for files and insert their paths.
   *
   * Opens the explorer's picker AT THIS CHAT'S working directory — its worktree
   * when it has one, else the project checkout (`chatRoot`, shared with the
   * server so the two cannot disagree about where a chat runs). That is the
   * whole point of the surface: the paths it inserts have to be paths the agent
   * for THIS chat can actually open.
   *
   * Multi-select, because `insertPaths` already lays several out one per line
   * and "here are the three files" is the common ask. The picker it replaced
   * could only ever answer with one.
   *
   * Inserted in the SERVER's native separators. Everything crossing the wire is
   * forward-slashed, but what lands in the message becomes shell commands and
   * tool calls on that machine, so it should read like a path from that
   * machine's own file manager — which is what the old picker inserted too.
   */
  const pickAndInsertPaths = async (initialQuery = "") => {
    const picked = await pickPath({
      select: "file",
      multiple: true,
      initialPath: pickerRoot,
      initialQuery,
      title: "Insert file paths",
    });
    if (!picked?.length) return;
    // Read the platform AFTER the await, not from the enclosing render.
    // The fetch that establishes it is kicked off by the picker itself, so at
    // the moment this handler was created the store still held its pre-load
    // default — which inserted `C:/Users/…` instead of `C:\Users\…`.
    const platform = useFsRoots.getState().platform ?? "posix";
    insertPaths(picked.map((p) => fsToNative(p, platform)));
  };

  /**
   * One drop, two outcomes: anything carrying file CONTENT is uploaded and
   * attached, the same way and with the same retention as a pasted screenshot;
   * a fileless path drag (an editor tab, a terminal) inserts the path. Returns
   * whether the drop was consumed.
   *
   * Uploading replaced guessing a path from the basename against the project
   * index — which only ever worked for files already in the repo, and inserted
   * a wrong path, silently, for a same-named file anywhere else. `dropIntent`
   * predicts the branch so the overlay can say so mid-drag; change one and
   * change the other.
   */
  const handleDrop = (dt: DataTransfer | null): boolean => {
    // Cleared here, not only in the shell's onDrop: a drop landing on the text
    // area is consumed by ProseMirror, which stops propagation before the
    // shell's handler ever runs. Without this the overlay outlives the drop.
    setOver(null);
    const { files, folders } = filesFrom(dt);
    if (files.length || folders) {
      // addFiles clears the error synchronously, so the folder note has to be
      // set AFTER it starts or a mixed drop silently loses it. A later upload
      // failure still replaces it — a file that didn't attach matters more.
      void addFiles(files);
      if (folders) {
        setError(
          `Folders can't be attached — drop the files inside${folders > 1 ? ` (${folders} folders skipped)` : ""}.`,
        );
      }
      return true;
    }
    const paths = pathsFromDrop(dt);
    if (paths.length) {
      insertPaths(paths);
      return true;
    }
    return false;
  };
  handleDropRef.current = handleDrop;

  const removeAttachment = (id: string) => {
    putAttachments(attachmentsRef.current.filter((x) => x.id !== id));
    setEditing((e) => (e?.id === id ? null : e));
  };

  // The markup editor returns a freshly-uploaded ImageRef; swap it in place of
  // the original attachment so the edited version is what actually sends.
  const applyEdit = (original: ImageRef, next: ImageRef) => {
    putAttachments(attachmentsRef.current.map((x) => (x.id === original.id ? next : x)));
    setEditing(null);
  };

  /**
   * Send what's in the box.
   *
   * `mode` is which of the three mid-turn behaviours to use, defaulting to the
   * app's pin — so the button, Ctrl/⌘↵ and a dropup row all arrive here and
   * differ only in that argument. It is passed through unconditionally: the
   * server ignores it unless a turn is actually live, which keeps the "is
   * anything running" judgement in the one place that cannot be stale by the time
   * the message lands.
   */
  const submit = (mode: SendMode = appSendMode) => {
    // Serialize with single-newline separators: paragraph breaks join with "\n"
    // (not the default "\n\n", which doubled every newline) and hard breaks — which
    // getText otherwise drops entirely — also become "\n".
    const text =
      editor
        ?.getText({ blockSeparator: "\n", textSerializers: { hardBreak: () => "\n" } })
        .trim() ?? "";
    if ((!text && attachments.length === 0) || uploading > 0) return;
    // Here, not just on the button: Send is only aria-disabled (it stays
    // clickable) and Ctrl/⌘↵ lands here too. Past this line the editor, draft
    // and attachments are cleared, so a turn the server is about to refuse
    // would cost the draft the banner promises to keep.
    if (unavailable) return;

    actions.sendMessage(chat.id, {
      text: text || undefined,
      images: attachments.length ? attachments : undefined,
      effort: chat.effort,
      sendMode: mode,
    });

    // Sending ends the dictation that composed it — otherwise the tail of the
    // sentence you just sent lands at the top of the next message.
    dictation.stop();
    slash.close();
    editor?.commands.clearContent();
    clearDraft(chat.id);
    attachmentsRef.current = [];
    setAttachments([]);
    setEditing(null);
    setIsEmpty(true);
    setError(null);
  };
  submitRef.current = submit;

  /**
   * Pin what Ctrl/⌘↵ and the Send button do from now on.
   *
   * Applied to the local store BEFORE the request, off the response body, so the
   * menu's check mark and the button's label move under the pointer instead of
   * after a round trip. The endpoint returns the saved settings, so a rejected
   * write is corrected by the same `apply` rather than left lying.
   */
  const pinSendMode = (mode: SendMode) => {
    const was = appSendMode;
    pinDefaultSendMode(mode);
    api.settings
      .setSendMode(mode)
      // The endpoint returns the whole saved settings, so the authoritative body
      // replaces the guess rather than sitting beside it.
      .then((saved) => applySettings(saved))
      .catch((err) => {
        pinDefaultSendMode(was);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  /* ------------------------------------------------------------ / commands */

  const slash = useSlashCommands(chat.id);
  slashTextRef.current = slash.onText;

  /**
   * Replace the whole message with the chosen command and a trailing space.
   *
   * Replacement rather than insertion: the menu is only ever open when the
   * document IS the slash token (see `SLASH_TOKEN_RE`), so replacing it is both
   * correct and immune to where the caret happens to be.
   *
   * The content is a ProseMirror JSON doc, NOT an HTML string. `setContent`
   * parses HTML through the DOM, which collapses the trailing space away — and
   * that space is load-bearing: it is what stops the text matching the token
   * pattern, which is what keeps the menu shut while you type the arguments.
   *
   * `emitUpdate: true` (the second argument; it defaults to FALSE) is what makes
   * this one write go through the same `onUpdate` every keystroke does — which
   * is the only thing that calls `saveDraft`. Without it, picking `/review` and
   * then switching chats restores the draft written by the last real keystroke:
   * `/rev`, the half-typed token, silently replacing the command you chose.
   */
  const pickCommand = (name: string) => {
    slash.close();
    editor?.commands.setContent(
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: `/${name} ` }] }],
      },
      true,
    );
    editor?.commands.focus("end");
  };

  slashKeyRef.current = (event: KeyboardEvent) => {
    if (slash.query === null) return false;
    const action = slashKeyAction(event);
    if (action === "close") {
      slash.close();
      return true;
    }
    // Everything below needs a row to act on. Falling through when the list is
    // empty is what keeps a message that merely STARTS with a slash sendable.
    if (!action || !slash.matches.length) return false;
    if (action === "next") return slash.move(1);
    if (action === "prev") return slash.move(-1);
    const cmd = slash.current();
    if (!cmd) return false;
    pickCommand(cmd.name);
    return true;
  };

  // `null` clears the pin: the chat goes back to inheriting project → app.
  // Optimistic on the row (`undefined` IS the unpinned state), then the server.
  // One gate for every mode surface, not one per surface. The toolbar's
  // `ModeControl` takes `locked`, but the compact options sheet renders
  // `ModeMenu` directly — and this optimistic `upsertChat` is what makes a
  // missed surface visible: the broker refuses a non-global mode WITHOUT a
  // corrective `chat-update`, so the badge would claim the new mode forever
  // while the session stayed in Global. Refusing here cannot be forgotten by
  // whoever adds the third surface.
  const modeLocked = isGlobalProject(chat.projectId);
  const setMode = (next: string | null) => {
    if (modeLocked) return;
    upsertChat({ ...chat, modeId: next ?? undefined });
    actions.setMode(chat.id, next);
  };
  const setEffort = (next: Effort | null) => {
    upsertChat({ ...chat, effort: next ?? undefined });
    actions.setEffort(chat.id, next);
  };
  const setAgent = (id: string) => {
    const agentId = id === "" ? null : id;
    upsertChat({ ...chat, agentId: agentId ?? undefined });
    actions.setAgent(chat.id, agentId);
  };
  const chooseModel = (m: string | null) => {
    if (m === null) modelByChat.delete(chat.id);
    else modelByChat.set(chat.id, m);
    setModelState(
      m ?? posture.model.inherited ?? (harness ? defaultModelFor(harness) : undefined) ?? "",
    );
    upsertChat({ ...chat, model: m ?? undefined });
    actions.setModel(chat.id, m);
    // A plain model and a custom agent are mutually-exclusive "brains" here —
    // picking a model drops any custom agent so the model actually takes effect.
    if (chat.agentId) setAgent("");
  };

  /* ------------------------------------------------------------ inherit rows */

  // One "inherit" row per layered control, built the same way so the effort
  // picker, the mode menu and the model list all say "Inherit · X · from …"
  // and all offer the same way back. `active` when the chat has no pin.
  const effortLabelOf = (e: Effort) => effortOptions.find((o) => o.value === e)?.label ?? e;
  const effortInherit: SelectInherit = {
    label: `${posture.effort.source === "chat" ? "Use default" : "Inherit"} · ${effortLabelOf(posture.effort.inherited)}`,
    hint: postureSourceShort(posture.effort.inheritedSource),
    active: posture.effort.source !== "chat",
    onSelect: () => setEffort(null),
  };
  const modeInherit: SelectInherit = {
    label: `${posture.modeId.source === "chat" ? "Use default" : "Inherit"} · ${modeLabel(modes, posture.modeId.inherited)}`,
    hint: postureSourceShort(posture.modeId.inheritedSource),
    active: posture.modeId.source !== "chat",
    onSelect: () => setMode(null),
  };
  const modelInherit: SelectInherit = {
    label: `${posture.model.source === "chat" ? "Use default" : "Inherit"} · ${
      posture.model.inherited ? modelLabelOf(posture.model.inherited) : "Provider default"
    }`,
    hint: postureSourceShort(posture.model.inheritedSource, "provider"),
    active: posture.model.source !== "chat",
    onSelect: () => chooseModel(null),
  };

  /* ------------------------------------------------------------- agent wiring */

  const scopedAgents = agents.filter(
    (a) => a.scope !== "project" || a.projectId === chat.projectId,
  );
  const currentAgent = scopedAgents.find((a) => a.id === chat.agentId);

  // A chat whose provider cannot run is not sendable: the server refuses that
  // turn anyway, and refusing here keeps the draft instead of losing it to a
  // round trip that ends in an error toast.
  const canSend = (!isEmpty || attachments.length > 0) && uploading === 0 && !unavailable;

  /* ----------------------------------------------- standing down for a question */

  // An open AskUserQuestion on THIS chat, if there is one. See lib/composerDefer
  // for why the composer gets out of its way, and for the reclaim latch.
  const question = useAttention((s) => blockingQuestion(s.items, chat.id));
  const [reclaimed, setReclaimed] = useState<string | null>(null);
  const deferred = composerDeferred(
    question,
    reclaimed,
    !isEmpty || attachments.length > 0 || uploading > 0,
  );
  // Scoped to the question it was aimed at, not a bare timestamp: the Composer
  // is NOT remounted on a chat switch, so one tap on chat A's stub followed
  // within the window by one on chat B's — exactly what triaging the Attention
  // Queue looks like — would otherwise read as a double-tap and hand back a
  // composer nobody asked for.
  const lastStubTapRef = useRef<{ id: string; at: number }>({ id: "", at: 0 });

  /**
   * How tall the stood-down composer actually is, measured.
   *
   * The stand-down bar stops following the keyboard by giving up exactly
   * `--dp-kb` of layout height (see the wrapper in the render), and that
   * subtraction has to start from the box's REAL height or it leaves a dead
   * band under the bar at rest. It cannot be a constant: the row below the bar
   * is the live control row, which is a different height with a Stop button in
   * it, at a different UI scale, or after the fit walk drops a rung. Observed
   * rather than read once, for the same reason.
   *
   * Only while deferred — the composer grows with every line you type, and an
   * observer that re-rendered on each of those would be a cost paid by everyone
   * for a number nothing reads.
   */
  const deferBoxRef = useRef<HTMLDivElement>(null);
  const [deferHeight, setDeferHeight] = useState(0);
  useLayoutEffect(() => {
    if (!deferred) {
      setDeferHeight(0);
      return;
    }
    const el = deferBoxRef.current;
    if (!el) return;
    const read = () => setDeferHeight(el.offsetHeight);
    read();
    // The wrapper constrains its OWN height, never the box's — the box is a
    // block that simply overflows it — so this cannot feed back on itself.
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [deferred]);
  // Named per device: there is no "tap" on a desktop and no "click" on a phone,
  // and this hint is the ONLY place the way back is written down.
  const reclaimHint = useMemo(
    () => (isTouchPrimary() ? "double-tap to type" : "double-click to type"),
    [],
  );

  /**
   * Hand the real composer back.
   *
   * `flushSync` so the editor is out of `display: none` and focusable BEFORE
   * this handler returns: iOS only raises the keyboard for a focus that happens
   * inside the gesture that asked for it, and a `requestAnimationFrame` here
   * would land outside it — giving back a composer with no keyboard, which on a
   * phone is giving back nothing.
   */
  const reclaimComposer = useCallback(() => {
    if (!question) return;
    flushSync(() => setReclaimed(question.id));
    editor?.commands.focus("end");
  }, [editor, question]);

  /**
   * One tap points at the card; two give up the nudge and hand the box back.
   *
   * The single tap is the whole "push toward answering, don't force it": the
   * most likely reason to be poking at the bottom of the screen with a question
   * open is that you have scrolled past the card and lost it, so the first tap
   * scrolls it back into view and flashes it.
   */
  const onStubTap = useCallback(() => {
    if (!question) return;
    const now = Date.now();
    const last = lastStubTapRef.current;
    if (last.id === question.id && isDoubleTap(now, last.at)) {
      lastStubTapRef.current = { id: "", at: 0 };
      reclaimComposer();
      return;
    }
    lastStubTapRef.current = { id: question.id, at: now };
    focusAttentionItem(question);
  }, [question, reclaimComposer]);

  /* ------------------------------------------------------ auto-sizing toolbar */

  // One measurement step. The row is `flex-nowrap` with non-shrinking children,
  // so `scrollWidth > clientWidth` means the current layout genuinely doesn't
  // fit — and the fix is to shrink exactly ONE control by one rung and measure
  // again. Each step re-renders and re-runs this effect, so the row converges on
  // the widest layout that fits, in at most (controls × rungs) passes. All of it
  // happens in layout effects, before paint, so the walk is never visible.
  //
  // Growing back is the same loop in reverse, gated on `blockedWidthRef`: the
  // width at which we last saw an overflow. Without that gate a promotion that
  // doesn't fit would be undone by the next demotion, forever.
  const step = useCallback(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const width = el.clientWidth;
    if (el.scrollWidth > width + 1) {
      // Remember that THIS layout is too wide here, so we don't immediately try
      // to grow back into the space we just proved isn't there.
      blockedWidthRef.current = width;
      setSizes((cur) => demote(cur, visibleRef.current) ?? cur);
      return;
    }
    if (width > blockedWidthRef.current + 4) {
      setSizes((cur) => promote(cur, visibleRef.current) ?? cur);
    }
  }, []);

  // Re-measure on width changes (debounced so a drag-resize doesn't thrash) and
  // once synchronously on mount — before paint, so an overflowing first render
  // never flashes. A ResizeObserver on the row catches container width changes.
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(step, 90);
    };
    step();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [step]);

  // Drive the convergence loop: every accepted step changes `sizes`, which runs
  // this again until neither `demote` nor `promote` has anything left to do.
  useLayoutEffect(() => {
    step();
  }, [step, sizes]);

  // The control labels (model / agent / mode name) change the natural width
  // without changing the row's box, so ResizeObserver won't fire. Worse, they
  // can only ever make the row NARROWER or wider by an amount we can't predict —
  // so clear the hysteresis gate and let the loop re-derive the whole layout from
  // scratch. `visible` belongs here for the same reason: switching a control on
  // changes the natural width without changing the box.
  useLayoutEffect(() => {
    blockedWidthRef.current = 0;
    setSizes((cur) => reconcile(cur, visible));
    step();
  }, [
    step,
    phone,
    // Stop appears beside Send mid-turn, which is ~60px the row suddenly hasn't
    // got — the layout has to be re-derived when a turn starts and ends.
    running,
    model,
    modeId,
    chat.agentId,
    effort,
    currentAgent?.name,
    persona.label,
    modeLabel(modes, modeId),
    visible,
    // A plugin control registering is a new icon the row has to make room for.
    runtimeControls,
  ]);

  /**
   * Move this chat onto another provider. Optimistic, mirroring what the server
   * writes: a provider move drops the native session and the model pin, which
   * belonged to the old provider's catalogue. The ONE switch path, shared by
   * the provider menu and the unavailable banner.
   */
  const switchProvider = (kind: HarnessKind) => {
    modelByChat.delete(chat.id);
    setModelState("");
    upsertChat({
      ...chat,
      harness: kind,
      sessionId: undefined,
      model: undefined,
      status: "idle",
    });
    actions.setHarness(chat.id, kind);
  };

  /* ------------------------------------------------------- shared menu bodies */

  /**
   * The model/agent list, at either density. The phone sheet cannot open the
   * toolbar's popover (that would be a popover inside the sheet — see the
   * `moreView` note above), so it shares these ROWS instead. A forked copy is
   * how two surfaces start disagreeing about which models a harness has.
   */
  const brainRows = (close: () => void, dense: boolean) =>
    brainProvider ? (
      <>
        <ConfigBackRow
          title={`${providerFor(brainProvider).label} account`}
          dense={dense}
          onBack={() => setBrainProvider(null)}
        />
        {accountRows(
          brainProvider,
          () => {
            setBrainProvider(null);
            close();
          },
          dense,
        )}
      </>
    ) : (
    <>
      <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">Provider</div>
      {/* The chat's own provider when nothing registers it any more (its plugin
          is off or gone). Without this row the menu listed only the OTHER
          providers, so the one the chat is actually on — and the reason it
          won't run — was nowhere in the place you go to change it. */}
      {harness && !harnesses.some((h) => h.kind === harness) && (
        <MenuItem
          icon={<TriangleAlert />}
          dense={dense}
          active
          disabled
          hint="not available"
          title={unavailable?.message}
        >
          <span className="flex items-center gap-2">
            {providerFor(harness).label}
            <Check className="size-3 text-accent" />
          </span>
        </MenuItem>
      )}
      {harnesses.map((candidate) => {
        // A provider with a choice of accounts drills into them rather than
        // switching outright — picking the account IS the switch, so a bare
        // provider click would have to guess which login to run under.
        const own = accounts.filter((a) => a.provider === candidate.kind);
        const nested = candidate.runtime.available && own.length > 1;
        const active = candidate.kind === harness;
        return (
        <MenuItem
          key={candidate.kind}
          icon={<Cpu />}
          dense={dense}
          active={active}
          disabled={!candidate.runtime.available}
          title={candidate.runtime.version}
          hint={
            !candidate.runtime.available ? (
              "not installed"
            ) : nested ? (
              <span className="flex items-center gap-1">
                <span className="max-w-[96px] truncate">
                  {active && accountName ? accountName : `${own.length} accounts`}
                </span>
                <ChevronRight className="size-3" />
              </span>
            ) : (
              candidate.runtime.version
            )
          }
          onClick={() => {
            if (!candidate.runtime.available) return;
            if (nested) {
              void useSubscriptions.getState().load();
              setBrainProvider(candidate.kind);
              return;
            }
            if (active) return;
            switchProvider(candidate.kind);
            close();
          }}
        >
          <span className="flex items-center gap-2 capitalize">
            {candidate.kind}
            {active && <Check className="size-3 text-accent" />}
          </span>
        </MenuItem>
        );
      })}
      <div className="my-1 h-px bg-line" />
      <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">
        Model · {providerFor(harness).label}
      </div>
      <MenuItem
        icon={<RotateCcw />}
        hint={modelInherit.hint}
        dense={dense}
        active={modelInherit.active}
        onClick={() => {
          modelInherit.onSelect();
          close();
        }}
      >
        <span className="flex items-center gap-2">
          {modelInherit.label}
          {modelInherit.active && <Check className="size-3 text-accent" />}
        </span>
      </MenuItem>
      {models.map((m) => (
        <MenuItem
          key={m.value}
          icon={<Cpu />}
          hint={m.hint}
          title={m.description}
          dense={dense}
          active={m === selectedModel && !modelInherit.active}
          onClick={() => {
            chooseModel(m.value);
            close();
          }}
        >
          <span className="flex items-center gap-2">
            {m.label}
            {m === selectedModel && !modelInherit.active && <Check className="size-3 text-accent" />}
          </span>
        </MenuItem>
      ))}
    </>
    );

  /** The effort list, shared by the toolbar's own Select and the options menu. */
  const effortRows = (close: () => void, dense: boolean) => (
    <div className="flex flex-col">
      <MenuItem
        icon={<RotateCcw />}
        hint={effortInherit.hint}
        dense={dense}
        active={effortInherit.active}
        onClick={() => {
          effortInherit.onSelect();
          close();
        }}
      >
        <span className="flex items-center gap-2">
          {effortInherit.label}
          {effortInherit.active && <Check className="size-3 text-accent" />}
        </span>
      </MenuItem>
      <div className="my-1 h-px bg-line" />
      {effortOptions.map((o) => (
        <MenuItem
          key={o.value}
          dense={dense}
          icon={<EffortGauge effort={o.value} />}
          hint={o.hint}
          active={o.value === effort && !effortInherit.active}
          onClick={() => {
            setEffort(o.value);
            close();
          }}
        >
          <span className="flex items-center gap-2">
            {o.label}
            {o.value === effort && !effortInherit.active && <Check className="size-3 text-accent" />}
          </span>
        </MenuItem>
      ))}
      {/* The same "what actually ran" disclosure the wide toolbar makes inline. */}
      {effectiveEffort && effectiveEffort !== effort && (
        <div className="px-3 py-2">
          <EffortChip effort={effectiveEffort} label="running at" />
        </div>
      )}
    </div>
  );

  /** Attach's two actions — split because the OS dialog can't return a path. */
  const attachRows = (close: () => void, dense: boolean) => (
    <div className="flex flex-col">
      <MenuItem
        dense={dense}
        icon={<Paperclip />}
        hint="upload"
        onClick={() => {
          fileInputRef.current?.click();
          close();
        }}
      >
        Attach files…
      </MenuItem>
      <MenuItem
        dense={dense}
        icon={<FileIcon />}
        hint="as text"
        onClick={() => {
          // Close FIRST: the menu is a Popover that traps focus, and the picker
          // autofocuses its search box the frame it mounts.
          close();
          void pickAndInsertPaths();
        }}
      >
        Insert file path…
      </MenuItem>
    </div>
  );

  /** Which controls the toolbar TRIES to show — nested under the options menu. */
  const customizeRows = (dense: boolean) => (
    <div className="flex flex-col">
      <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">Show in composer</div>
      {allControls().map((c) => (
        <MenuItem
          key={c.id}
          dense={dense}
          icon={(visible[c.id] ?? true) ? <Check className="text-accent" /> : <span className="size-3" />}
          hint={c.hint}
          onClick={() => toggleControl(c.id)}
        >
          <span className={(visible[c.id] ?? true) ? "text-primary" : "text-muted"}>{c.label}</span>
        </MenuItem>
      ))}
      {hidden > 0 && (
        <>
          <div className="my-1 h-px bg-line" />
          <MenuItem icon={<Eye />} dense={dense} onClick={showAllControls}>
            Show all
          </MenuItem>
        </>
      )}
      {/* Wanting a control and not seeing it is the one confusing outcome of an
          automatic layout, so the menu says so rather than leaving you to
          wonder whether the toggle took. */}
      {evicted > 0 && (
        <div className="px-2 py-1.5 text-2xs leading-snug text-faint">
          {evicted} shown {evicted === 1 ? "control doesn't" : "controls don't"} fit this width and
          {evicted === 1 ? " is" : " are"} only in this menu. Widen the window or hide another.
        </div>
      )}
    </div>
  );

  /**
   * The options surface, at either density. Root is a plain list of EVERY
   * control — this menu is the one place that always has all of them, whichever
   * ones the row had room for — and each row drills into that control's own menu
   * in place. Both the desktop popover and the phone sheet render this same
   * function, so the two surfaces cannot drift apart.
   */
  /**
   * Every account, grouped by provider. Picking one on ANOTHER provider moves
   * the chat there (the server treats it as a provider switch), so the rows say
   * which provider each group is rather than hiding the others.
   */
  const chooseAccount = (target: SubscriptionStatus) => {
    if (!target.loggedIn || target.id === account?.id) return;
    const movesProvider = target.provider !== harness;
    if (movesProvider) {
      modelByChat.delete(chat.id);
      setModelState("");
    }
    // Optimistic, mirroring what the server will write: an implicit account is
    // never pinned (see `pinnedIdOf`), and a provider move drops the native
    // session and model the way `setHarness` does.
    upsertChat({
      ...chat,
      subscriptionId: target.implicit ? undefined : target.id,
      ...(movesProvider
        ? { harness: target.provider, sessionId: undefined, model: undefined, status: "idle" }
        : {}),
    });
    actions.setSubscription(chat.id, target.id);
  };

  /** One provider's accounts — the model menu's drilled-in page. */
  const accountRows = (
    provider: SubscriptionStatus["provider"],
    close: () => void,
    dense: boolean,
  ) =>
    accounts
      .filter((a) => a.provider === provider)
      .map((a) => (
        <MenuItem
          key={a.id}
          icon={<KeyRound />}
          dense={dense}
          active={a.id === account?.id}
          disabled={!a.loggedIn}
          hint={!a.loggedIn ? "not logged in" : a.isDefault ? "default" : undefined}
          title={a.resolvedConfigDir}
          onClick={() => {
            chooseAccount(a);
            close();
          }}
        >
          <span className="flex items-center gap-2">
            {accountLabel(a)}
            {a.id === account?.id && <Check className="size-3 text-accent" />}
          </span>
        </MenuItem>
      ));

  const configSurface = (close: () => void, dense: boolean) => {
    if (moreView === "attach") return attachRows(close, dense);
    if (moreView === "mode")
      return (
        <ModeMenu
          modes={modes}
          value={modeId}
          onChange={setMode}
          close={close}
          dense={dense}
          inherit={modeInherit}
        />
      );
    if (moreView === "effort") return effortRows(close, dense);
    if (moreView === "brain") return <div className="flex flex-col">{brainRows(close, dense)}</div>;
    if (moreView === "persona") return <PersonaRows picker={persona} close={close} dense={dense} />;
    if (moreView === "context")
      return <ContextPanelBody chatId={chat.id} model={model} close={close} />;
    if (moreView === "customize") return customizeRows(dense);
    if (moreView === "voice") return voiceRows(dense);
    const runtime = runtimeControls.find((c) => c.id === moreView);
    if (runtime)
      return (
        <div className="flex flex-col">
          <SlotErrorBoundary pluginId={runtime.owner ?? runtime.id} slot={`${runtime.label} menu`} resetKey={chat.id}>
            {runtime.menu}
          </SlotErrorBoundary>
        </div>
      );
    return (
      <div className="flex flex-col">
        <MenuItem
          dense={dense}
          icon={<Paperclip />}
          hint="files / path"
          onClick={() => setMoreView("attach")}
        >
          Attach
        </MenuItem>
        {/* Dictate is an action, not a menu — it toggles from here directly.
            Press-and-hold only works on the toolbar's own button, which is why
            Dictate is the last control the row ever gives up. */}
        <MenuItem
          dense={dense}
          icon={<Mic />}
          disabled={!!dictation.unavailable}
          hint={
            dictation.unavailable ? "unavailable" : dictation.listening ? "listening" : "microphone"
          }
          onClick={() => {
            dictation.toggle();
            close();
          }}
        >
          {dictation.listening ? "Stop dictating" : "Dictate"}
        </MenuItem>
        {/* Not offered at all for a global chat — `setMode` would refuse it,
            and a row that opens a menu where every choice does nothing is
            worse than no row. The hint still says which mode it is in. */}
        <MenuItem
          dense={dense}
          icon={modeIcon(modes, modeId)}
          hint={modeLabel(modes, modeId)}
          onClick={modeLocked ? undefined : () => setMoreView("mode")}
        >
          Mode &amp; posture
        </MenuItem>
        <MenuItem
          dense={dense}
          icon={<EffortGauge effort={effort} />}
          hint={effortLabelOf(effort)}
          onClick={() => setMoreView("effort")}
        >
          Effort
        </MenuItem>
        <MenuItem
          dense={dense}
          icon={currentAgent ? <Bot /> : <Cpu />}
          hint={currentAgent ? currentAgent.name : modelLabelOf(model)}
          onClick={() => {
            setBrainProvider(null);
            void useSubscriptions.getState().load();
            setMoreView("brain");
          }}
        >
          Model
        </MenuItem>
        <MenuItem
          dense={dense}
          icon={<Drama />}
          hint={persona.label ?? "off"}
          onClick={() => {
            void persona.refresh();
            setMoreView("persona");
          }}
        >
          Persona
        </MenuItem>
        <MenuItem
          dense={dense}
          icon={<Gauge />}
          hint={<ContextHint chatId={chat.id} model={model} />}
          onClick={() => setMoreView("context")}
        >
          Context
        </MenuItem>
        {/* Plugin controls: a root row each, exactly like the built-ins above,
            so an evicted one is still reachable here. A control with a `menu`
            drills in; one without runs its action and closes. */}
        {runtimeControls.map((c) => (
          <MenuItem
            key={c.id}
            dense={dense}
            icon={c.icon}
            hint={c.hint}
            onClick={() => {
              if (c.menu !== undefined) {
                setMoreView(c.id);
              } else {
                c.onSelect?.();
                close();
              }
            }}
          >
            {c.label}
          </MenuItem>
        ))}
        <div className="my-1 h-px bg-line" />
        {/* Read streamed replies aloud through the active TTS engine. A
            toggle row here rather than a toolbar control: it is a standing
            per-browser preference, not a per-turn choice, and the toolbar is
            for things that change per message. */}
        <MenuItem
          dense={dense}
          icon={<Volume2 className={cn(speakReplies && "text-accent")} />}
          hint={speakReplies ? ttsLabel : "off"}
          onClick={() => setSpeakReplies(!speakReplies)}
        >
          Speak replies
        </MenuItem>
        {/* Only once a plugin has registered an engine: with just the two
            built-ins there is nothing to choose between. */}
        {dictationEngines.length + ttsEngines.length > 2 && (
          <MenuItem
            dense={dense}
            icon={<AudioLines />}
            hint={`${dictationEngines.length + ttsEngines.length} engines`}
            onClick={() => setMoreView("voice")}
          >
            Voice engines…
          </MenuItem>
        )}
        <MenuItem
          dense={dense}
          icon={<Settings2 />}
          hint={hidden ? `${hidden} hidden` : "all shown"}
          onClick={() => setMoreView("customize")}
        >
          Composer controls…
        </MenuItem>
      </div>
    );
  };

  /**
   * Which dictation and TTS engine this browser uses — the built-in plus
   * whatever plugins registered (lib/engines). One list each, radio-style; an
   * engine that says it cannot run here is listed disabled with the reason as
   * its hint, so "why is Whisper greyed out" answers itself.
   */
  const voiceRows = (dense: boolean) => (
    <div className="flex flex-col">
      <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">Dictation</div>
      {dictationEngines.map((d) => {
        const why = d.unavailable?.() ?? null;
        return (
          <MenuItem
            key={d.id}
            dense={dense}
            icon={d.id === dictationId ? <Check className="text-accent" /> : <span className="size-3" />}
            hint={why ?? undefined}
            disabled={!!why}
            onClick={() => selectDictation(d.id)}
          >
            {d.label}
          </MenuItem>
        );
      })}
      <div className="my-1 h-px bg-line" />
      <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">Speech</div>
      {ttsEngines.map((d) => {
        const why = d.unavailable?.() ?? null;
        return (
          <MenuItem
            key={d.id}
            dense={dense}
            icon={d.id === ttsId ? <Check className="text-accent" /> : <span className="size-3" />}
            hint={why ?? undefined}
            disabled={!!why}
            onClick={() => selectTts(d.id)}
          >
            {d.label}
          </MenuItem>
        );
      })}
    </div>
  );

  const CONFIG_TITLE: Record<string, string> = {
    attach: "Attach",
    mode: "Mode & posture",
    effort: "Effort",
    brain: "Model",
    persona: "Persona",
    context: "Context",
    customize: "Composer controls",
    voice: "Voice engines",
    ...Object.fromEntries(runtimeControls.map((c) => [c.id, c.label])),
  };

  const closeMore = () => setMoreOpen(false);

  return (
    <>
      {/* The stand-down wrapper. It gives up exactly `--dp-kb` of layout
          height, which is what stops the composer following the keyboard: the
          shell shrinks by that much to sit above it (see App.tsx), so a box
          that shrinks by the same amount stays physically PUT — it ends up in
          the band the keyboard now covers, and the room it vacated goes to the
          transcript, which is where the question being answered actually is.
          The overhang is drawn, not clipped: the shell's `overflow: hidden`
          clips at its PADDING box, and that band IS the padding. `--dp-kb` is
          0px whenever no keyboard is up, and on desktop always, so this is a
          no-op everywhere else. */}
      <div
        style={
          deferred && deferHeight
            ? { height: `max(0px, calc(${deferHeight}px - var(--dp-kb, 0px)))` }
            : undefined
        }
      >
    <div ref={deferBoxRef} className="border-t border-line bg-surface/80 px-4 py-3">
      <div className="mx-auto w-full max-w-[860px]">
      {/* Two different states, deliberately worded as such: a steered message is
          already inside the running turn's input and may be read at any moment,
          where a withheld one has not been handed over at all and cannot be seen
          until the next turn starts. One chip for both would make the difference
          between Steer and Queue invisible at exactly the moment it matters. */}
      {queued > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <Chip tone="accent" icon={<Layers />}>
            {queued} steering
          </Chip>
          <span className="text-xs text-muted">
            {queued === 1 ? "message" : "messages"} will inject into the current turn
          </span>
        </div>
      )}
      {pending > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <Chip icon={SEND_MODE_ICON.queue}>{pending} waiting</Chip>
          <span className="text-xs text-muted">
            {pending === 1 ? "message" : "messages"} will send when this turn finishes
          </span>
        </div>
      )}
      {/* Provider unavailable — a STATE, not a toast (#426). It used to flash
          "x is unavailable; using claude" and quietly move the chat to Claude
          for good. Now the chat stays on its provider and says why it can't
          run; it clears by itself when the provider comes back, and the way
          out — another provider — is offered right here. */}
      {unavailable && (
        <div
          role="status"
          data-testid="provider-unavailable"
          className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-warn-line bg-warn-ghost px-3 py-2 text-xs text-secondary [&_svg]:size-3.5"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <TriangleAlert className="shrink-0 text-warn" />
            <span className="min-w-0">
              {unavailable.message}{" "}
              <span className="text-muted">
                {switchable.length
                  ? "Switch provider to keep going, or bring this one back."
                  : "No other provider is available — enable one in Settings → Plugins."}
              </span>
            </span>
          </span>
          {switchable.slice(0, 3).map((h) => (
            <Button
              key={h.kind}
              size="sm"
              leftIcon={<Cpu />}
              onClick={() => switchProvider(h.kind)}
            >
              Switch to {providerFor(h.kind).label}
            </Button>
          ))}
        </div>
      )}

      <div
        className={cn(
          "relative rounded-lg border border-line bg-panel-2 transition-colors",
          // The focus frame belongs to the WHOLE composer, not the text box
          // inside it. The global `:focus-visible` ring (index.css) drew a
          // rectangle around the contenteditable alone, which read as a second,
          // smaller field floating inside the real one — worst on mobile, where
          // the toolbar and attachment strip sat visibly OUTSIDE the lit border.
          // `.cm-prose .ProseMirror` opts out of that ring; this is what
          // replaces it.
          "focus-within:border-accent-line focus-within:ring-1 focus-within:ring-accent-line",
          // Carrying an attachment lifts the fill a rung so the box reads as
          // holding something — the accent frame above still wins the border.
          (attachments.length > 0 || uploading > 0) && "bg-elevated",
          // Lit from the moment a file enters the WINDOW, not just this box:
          // the target has to be findable before you're on top of it.
          fileDrag.active && "border-accent-line ring-1 ring-accent-line",
          over && "border-accent ring-2 ring-accent-line",
        )}
        onDragOver={(e) => {
          const intent = dropIntent(e.dataTransfer);
          if (!intent) return;
          e.preventDefault();
          setOver((prev) => (prev === intent ? prev : intent));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
        }}
        onDrop={(e) => {
          if (handleDrop(e.dataTransfer)) e.preventDefault();
          setOver(null);
        }}
      >
        {/* The `/` menu. Inside the shell because that's the `relative` box it
            anchors to, and above everything else in it so a drop overlay can't
            paint over the list. */}
        {slash.query !== null && (
          <SlashMenu
            commands={slash.matches}
            active={slash.active}
            onHover={slash.setActive}
            onPick={(cmd) => pickCommand(cmd.name)}
            builtinsKnown={slash.builtinsKnown}
          />
        )}
        {/* The promise, made before the user commits. `over` wins so the copy
            reflects the box actually under the pointer. */}
        {(over ?? (fileDrag.active ? fileDrag.intent : null)) && (
          <DropOverlay intent={(over ?? fileDrag.intent)!} armed={over !== null} />
        )}
        {/* attachment strip */}
        {(attachments.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5">
            {attachments.map((img) => (
              <div
                key={img.id}
                className="group/att relative flex items-center gap-2 rounded-md border border-line bg-inset py-1 pl-1 pr-2"
              >
                {isFileRef(img) ? (
                  // A file has nothing to annotate — just say what it is.
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-[5px] border border-line-soft text-muted [&_svg]:size-4"
                    aria-hidden
                  >
                    <FileIcon />
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(img)}
                    title="Click to annotate or crop"
                    aria-label="Edit image"
                    className="group/thumb relative size-8 shrink-0 overflow-hidden rounded-[5px] border border-line-soft"
                  >
                    <AssetImage chatId={chat.id} img={img} className="size-full object-cover" />
                    <span className="absolute inset-0 flex items-center justify-center bg-scrim text-primary opacity-0 transition-opacity group-hover/thumb:opacity-100 [&_svg]:size-3.5">
                      <Pencil />
                    </span>
                  </button>
                )}
                <div className="leading-tight">
                  <div className="max-w-[160px] truncate text-xs text-secondary" title={img.alt ?? filenameOf(img)}>
                    {img.alt ?? filenameOf(img)}
                  </div>
                  <div className="cm-mono !text-2xs text-faint">
                    {img.width && img.height
                      ? `${img.width}×${img.height}`
                      : isFileRef(img)
                        ? fileTypeLabel(img)
                        : (img.mimeType ?? "image")}
                  </div>
                </div>
                <button
                  onClick={() => removeAttachment(img.id)}
                  className="ml-1 text-faint opacity-0 transition-opacity hover:text-danger group-hover/att:opacity-100 [&_svg]:size-3"
                  aria-label="remove attachment"
                >
                  <X />
                </button>
              </div>
            ))}
            {Array.from({ length: uploading }).map((_, i) => (
              <div
                key={`up-${i}`}
                className="flex items-center gap-2 rounded-md border border-line bg-inset py-1 pl-2 pr-3"
              >
                <Spinner size={14} />
                <span className="text-xs text-muted">uploading…</span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="px-3 pt-2 text-xs text-danger" role="alert">
            {error}
          </div>
        )}

        {/* A failed mic is reported separately from `error` (send/upload
            failures): the two are unrelated, and one must not clear the other. */}
        {dictation.error && (
          <div
            className="flex items-start gap-2 px-3 pt-2 text-xs text-danger"
            role="alert"
          >
            <span className="min-w-0 flex-1">{dictation.error}</span>
            <button
              onClick={dictation.dismissError}
              aria-label="Dismiss"
              className="shrink-0 text-faint hover:text-danger [&_svg]:size-3"
            >
              <X />
            </button>
          </div>
        )}

        {/* Persona failures get their own slot for the same reason. */}
        {persona.error && (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs text-danger" role="alert">
            <span className="min-w-0 flex-1">{persona.error}</span>
            <IconButton tip="Dismiss" onClick={persona.dismissError} className="shrink-0">
              <X />
            </IconButton>
          </div>
        )}

        {/* The stand-down row, in place of the text box — the control row
            below it stays live and visible on purpose: deciding what to do
            about the question means reading the model, the effort, the context
            left and whether a turn is still running, and a bar that hid all of
            that would be pushing you toward an answer with the evidence
            removed. `RowButton`, not `Button`: this is a whole row that happens
            to be clickable, and `Button` is `h-6 justify-center
            whitespace-nowrap` with padding of its own. */}
        {deferred && (
          <RowButton
            onClick={onStubTap}
            aria-label={`Answer the question above, or ${reclaimHint} a message anyway`}
            className="flex w-full items-center gap-2 px-3 pb-1 pt-2.5 text-xs text-muted hover:text-secondary"
          >
            <span className="flex w-full items-center gap-2 rounded-md border border-dashed border-line bg-inset/60 px-2.5 py-1.5">
              <ArrowUp className="size-3.5 shrink-0" />
              <span className="flex-1 truncate">Answer the question above</span>
              <span className="shrink-0 text-2xs uppercase tracking-wide text-muted/70">
                {reclaimHint}
              </span>
            </span>
          </RowButton>
        )}
        {/* editor */}
        <div className={cn("cm-prose px-3 py-2.5", deferred && "hidden")}>
          <EditorContent editor={editor} />
          {/* Live transcript. Only the interim guess lives here — finalized
              phrases have already been inserted into the editor above — so this
              strip shows the words still in flight and nothing else. It sits
              outside the editor because TipTap owns that DOM; rendering into it
              would fight ProseMirror for the same nodes. */}
          {dictation.listening && (
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-danger"
              />
              <span className="min-w-0 flex-1 truncate italic">
                {dictation.interim || "Listening…"}
              </span>
            </div>
          )}
        </div>
        {/* Screen readers get the transcript as it settles, not on every keystroke
            of interim churn. */}
        <span className="sr-only" role="status" aria-live="polite">
          {dictation.listening ? "Dictating" : ""}
        </span>

        {/* toolbar — flex-nowrap + non-shrinking children so an over-wide full
            layout genuinely overflows (which `measure` detects and collapses to
            icons); overflow-hidden guarantees it never spills past the rounded
            border even during the brief debounce window. */}
        <div
          ref={toolbarRef}
          className="flex flex-nowrap items-center gap-1.5 overflow-hidden border-t border-line-soft px-2 py-2 [&>*]:shrink-0"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) addFiles(files);
              e.target.value = "";
            }}
          />
          {/* Attach: an image (uploaded, sent with the message) or a file PATH
              (inserted as text). They're split because the OS dialog can only
              ever return an image's CONTENT — never a path — so a path has to
              come from the server-backed picker instead.

              Icon-only at every width: there is no value to display, so a
              labelled form would just be a wider paperclip. */}
          {sizes.attach !== "off" && (
          <Popover
            align="start"
            width={210}
            className="p-1"
            trigger={({ open, toggle }) => (
              <IconButton size={phone ? "md" : "sm"} tip="Attach" active={open} onClick={toggle}>
                <Paperclip />
              </IconButton>
            )}
          >
            {(close) => attachRows(close, !phone)}
          </Popover>
          )}

          {/* Dictation. One control, two gestures: tap to latch the mic on, or
              press and hold to talk only while held (as does holding the
              push-to-talk key anywhere). `onPointerDown` rather than `onClick`
              is what makes the
              hold gesture possible at all — and it starts capturing on the way
              down, so holding doesn't clip the first word.

              This is also why Dictate is the LAST control the row gives up when
              it runs out of width: press-and-hold cannot survive a menu that
              closes on selection, so the menu's copy of it is a plain toggle and
              the gesture only exists here. */}
          {sizes.dictate !== "off" && (
          <IconButton
            size={phone ? "md" : "sm"}
            tip={
              dictation.unavailable
                ? "Dictation unavailable"
                : dictation.listening
                  ? "Stop dictating (or release)"
                  : `Dictate — tap to toggle, hold to talk (${PTT_LABEL})`
            }
            aria-pressed={dictation.listening}
            disabled={!!dictation.unavailable}
            active={dictation.listening}
            onPointerDown={(e) => {
              // Keep the caret in the message box; a focus jump to the button
              // would land the dictated text nowhere.
              e.preventDefault();
              dictation.pressStart();
            }}
            onPointerUp={dictation.pressEnd}
            onPointerCancel={dictation.pressEnd}
            onPointerLeave={dictation.pressEnd}
            className={cn(dictation.listening && "text-danger")}
          >
            <Mic className={cn(dictation.listening && "animate-pulse")} />
          </IconButton>
          )}

          {/* Mode AND posture — one control over one field (see ModeControl). */}
          {sizes.mode !== "off" && (
            <ModeControl
              modes={modes}
              value={modeId}
              onChange={setMode}
              size={sizes.mode as "lg" | "md" | "sm"}
              inherit={modeInherit}
              // The server pins the global chat's posture and refuses any
              // other id — and this control writes its selection optimistically,
              // so an offered-but-refused switch would leave the badge lying
              // about what the session is running as.
              locked={modeLocked}
              lockedHint="The global chat always runs in Global mode — it has no project to be safe in."
            />
          )}

          {sizes.effort !== "off" && (
            <>
              <Select
                options={effortOptions}
                value={effort}
                onChange={setEffort}
                inherit={effortInherit}
                leftIcon={<EffortGauge effort={effort} />}
                label="effort"
                width={196}
                size={sizes.effort as "lg" | "md" | "sm"}
                touch={phone}
              />

              {/* Only shown when the level that RAN differs from the one picked — an
                  agent pinning its own, or a model silently downgrading it. Silent
                  otherwise, so the row stays quiet in the normal case. Dropped
                  once effort itself is down to an icon: it is a disclosure, and a
                  row this cramped has no width to spend on one. */}
              {sizes.effort === "lg" && effectiveEffort && effectiveEffort !== effort && (
                <EffortChip effort={effectiveEffort} label="running at" />
              )}
            </>
          )}

          {/* model / agent — the session "brain": a custom agent's name when one
              is picked (secondary state), otherwise the active model label so it
              never misleadingly reads "No agent" while a model is running. */}
          {sizes.brain !== "off" && (
          <Popover
            align="start"
            width={210}
            className="p-1"
            trigger={({ open, toggle }) => {
              const onClick = () => {
                if (!open) {
                  setBrainProvider(null);
                  // Re-read on open: whether an account is logged in is a fact
                  // about a directory, and it changes when someone runs a login.
                  void useSubscriptions.getState().load();
                }
                toggle();
              };
              const btn = (
                <button
                  onClick={onClick}
                  aria-expanded={open}
                  aria-label={currentAgent ? "Agent" : "Model"}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border text-sm " +
                      "font-medium transition-colors [&_svg]:size-3.5",
                    phone ? "h-8" : "h-6",
                    sizes.brain === "sm" ? "justify-center px-1.5" : "px-2",
                    // Violet, not amber: a custom agent is machine chrome, and
                    // amber in this row means "live / yours" (see ui/Chip).
                    currentAgent
                      ? "border-accent-2-line bg-accent-2-ghost text-accent-2-hi hover:border-accent-2-line"
                      : "border-line bg-panel-2 text-secondary hover:border-line-strong hover:text-primary",
                    open && !currentAgent && "border-line-strong text-primary",
                  )}
                >
                  <span className={currentAgent ? "text-accent-2-hi" : "text-muted"}>
                    {currentAgent ? <Bot /> : <Cpu />}
                  </span>
                  {sizes.brain !== "sm" && (
                    <>
                      {/* A model id is long and an agent name can be longer, so
                          `md` gives the name half the room `lg` does rather than
                          dropping it — a truncated name still says which. */}
                      <span
                        className={cn(
                          "truncate",
                          sizes.brain === "md" ? "max-w-[68px]" : "max-w-[120px]",
                        )}
                      >
                        {currentAgent ? currentAgent.name : modelLabelOf(model)}
                      </span>
                      {sizes.brain === "lg" && <ChevronsUpDown className="ml-auto text-faint" />}
                    </>
                  )}
                </button>
              );
              return sizes.brain === "lg" ? (
                btn
              ) : (
                <Tooltip
                  label={
                    currentAgent
                      ? `Agent — ${currentAgent.name}`
                      : `Model — ${modelLabelOf(model)}`
                  }
                >
                  {btn}
                </Tooltip>
              );
            }}
          >
            {(close) => <div className="flex flex-col">{brainRows(close, !phone)}</div>}
          </Popover>
          )}

          {/* Persona sits beside the brain because it is the same kind of
              choice — who is answering — and its icon borrows the agent's violet
              when one is set. Off is the normal case, so off is just the icon. */}
          {sizes.persona !== "off" && (
          <Popover
            align="start"
            width={240}
            className="p-1"
            trigger={({ open, toggle }) => {
              const onClick = () => {
                if (!open) void persona.refresh();
                toggle();
              };
              // Colour on the svg, not the button: `cn` doesn't resolve class
              // conflicts, so a text colour beside the primitive's own is a coin
              // toss on Tailwind's emit order.
              const icon = <Drama className={cn(persona.label && "text-accent-2-hi")} />;
              return sizes.persona === "md" && persona.label ? (
                <Tooltip label={`Persona — ${persona.label}`}>
                  <Button
                    variant="subtle"
                    size={phone ? "md" : "sm"}
                    leftIcon={icon}
                    aria-expanded={open}
                    aria-label={`Persona: ${persona.label}`}
                    onClick={onClick}
                  >
                    <span className="max-w-[96px] truncate">{persona.label}</span>
                  </Button>
                </Tooltip>
              ) : (
                <IconButton
                  size={phone ? "md" : "sm"}
                  tip={persona.label ? `Persona — ${persona.label}` : "Persona — off"}
                  active={open}
                  aria-expanded={open}
                  onClick={onClick}
                >
                  {icon}
                </IconButton>
              );
            }}
          >
            {(close) => <PersonaRows picker={persona} close={close} dense={!phone} />}
          </Popover>
          )}

          {/* Plugin controls, after the built-ins and before the options menu.
              Each is an icon the ladder sized like any other (`sm` or `off`);
              what the icon IS is the plugin's `render`. */}
          {runtimeControls.map(
            (c) =>
              sizes[c.id] !== "off" && (
                <PluginSlot
                  key={c.id}
                  pluginId={c.owner ?? c.id}
                  slot={`${c.label} control`}
                  resetKey={chat.id}
                  render={c.render}
                  args={["sm"]}
                />
              ),
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* The options menu, and the one control that is never optional: it
                holds every control at every width, so it is both the way back
                from a toolbar you've emptied and the home of whatever the row
                couldn't fit. Same content either way — a sheet on touch, a
                popover on a pointer. */}
            {phone ? (
              <IconButton
                size="md"
                tip="Composer options"
                active={moreOpen}
                onClick={() => {
                  setMoreView("root");
                  setMoreOpen(true);
                }}
              >
                <SlidersHorizontal />
              </IconButton>
            ) : (
              <Popover
                align="end"
                width={280}
                className="p-1"
                trigger={({ open, toggle }) => (
                  <IconButton
                    tip={
                      evicted
                        ? `Composer options — ${evicted} won't fit`
                        : "Composer options"
                    }
                    active={open}
                    onClick={() => {
                      // Always reopen on the root list; a menu that remembers it
                      // was left three levels deep is a menu you have to escape.
                      setMoreView("root");
                      toggle();
                    }}
                  >
                    <Settings2 />
                  </IconButton>
                )}
              >
                {(close) => (
                  <>
                    {moreView !== "root" && (
                      <ConfigBackRow
                        title={CONFIG_TITLE[moreView] ?? ""}
                        dense
                        onBack={() => setMoreView("root")}
                      />
                    )}
                    {configSurface(close, true)}
                  </>
                )}
              </Popover>
            )}
            {sizes.context !== "off" && (
              <ContextMeter
                chatId={chat.id}
                model={model}
                size={sizes.context as "md" | "sm"}
                touch={phone}
              />
            )}
            {/* Stop the live turn — interrupts the running query server-side.
                Shown only mid-run, right beside Send so it's where the eye is. */}
            {running && (
              <Button
                type="button"
                variant="danger"
                size="md"
                circle={phone}
                leftIcon={<Square />}
                onClick={() => actions.interrupt(chat.id)}
                title="Stop the current turn"
                aria-label={phone ? "Stop the current turn" : undefined}
              >
                {phone ? null : "Stop"}
              </Button>
            )}
            {/* Gate by look, not the native `disabled` attribute: a disabled
                button swallows the click that lands in the same frame as the last
                keystroke (React commits `canSend` a tick later), which is why
                clicking Send used to no-op while ⌘↵ — which bypasses the button —
                worked. `submit` reads the live editor text and self-guards, so the
                click now always takes the exact same path as the shortcut. */}
            {/* Mid-turn the button is no longer just "Send": it names which of
                the three things it will do, because the default is settable and a
                button that said Send while quietly interrupting would be a trap.
                Idle it goes back to Send — none of the modes mean anything to a
                chat with no turn to act on. */}
            <Button
              type="button"
              variant="primary"
              size="md"
              // The bug this whole layout exists for: at 390px the labelled
              // button was the last thing in an `overflow-hidden` row, so "Send"
              // as a word was clipped off the right edge and the primary action
              // was unreachable on every phone.
              circle={phone}
              rightIcon={running ? SEND_MODE_ICON[appSendMode] : <ArrowUp />}
              onClick={() => submit()}
              aria-disabled={!canSend}
              title={
                running
                  ? `${SEND_MODE_LABEL[appSendMode]} — ${sendModeKeyHint(appSendMode)}`
                  : undefined
              }
              aria-label={phone ? (running ? SEND_MODE_LABEL[appSendMode] : "Send") : undefined}
              className={cn(!canSend && "opacity-45")}
            >
              {phone ? null : running ? SEND_MODE_LABEL[appSendMode] : "Send"}
            </Button>
            {running && (
              <SendModeMenu
                appDefault={appSendMode}
                onSend={submit}
                onPinDefault={pinSendMode}
                phone={phone}
              />
            )}
          </div>
        </div>
      </div>

      </div>

      {/* The same options surface as the pointer popover, as a bottom `Drawer`:
          a thumb-sized target list at the bottom of the screen beats a floating
          menu, and it's the same shape as the nav's More sheet. The CONTENT is
          `configSurface` either way, so the two can't drift. */}
      {phone && (
        <Drawer
          open={moreOpen}
          enabled
          onClose={closeMore}
          side="bottom"
          label="Composer options"
          className="max-h-[76dvh] flex-col overflow-hidden rounded-t-lg border-t border-line-strong bg-overlay/98 backdrop-blur-md"
        >
          {/* `min-h-0`: a flex child's default `min-height: auto` is its content,
              so without it the list refuses to shrink under the sheet's `max-h`
              and scrolls the page instead of itself. */}
          <div className="cm-scroll min-h-0 w-full overflow-y-auto p-1.5 pb-[calc(var(--dp-bottom-nav-space)+0.375rem)]">
            {moreView !== "root" && (
              <ConfigBackRow
                title={CONFIG_TITLE[moreView] ?? ""}
                dense={false}
                onBack={() => setMoreView("root")}
              />
            )}
            {configSurface(closeMore, false)}
          </div>
        </Drawer>
      )}

      <PersonaConfigureDialog picker={persona} />

      {editing && editingSrc && (
        <Suspense fallback={null}>
          <ImageAnnotator
            key={editing.id}
            chatId={chat.id}
            src={editingSrc}
            alt={editing.alt}
            onCancel={() => setEditing(null)}
            onApply={(next) => applyEdit(editing, next)}
          />
        </Suspense>
      )}
    </div>
      </div>
    </>
  );
}
