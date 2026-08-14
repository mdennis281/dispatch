import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Paperclip,
  ArrowUp,
  Bot,
  Map as MapIcon,
  Zap,
  Pencil,
  Layers,
  X,
  SlidersHorizontal,
  Settings2,
  Eye,
  BellOff,
  ShieldOff,
  Check,
  Cpu,
  ChevronsUpDown,
  Square,
  Image as ImageIcon,
  File as FileIcon,
  FileSearch,
  FileCode2,
  Mic,
} from "lucide-react";
import type { Chat, Effort, AgentConfig, ModeConfig, ImageRef } from "@dispatch/shared";
import { DEFAULT_MODEL, findModel } from "@dispatch/shared";
import { api, type IndexedFile } from "../../lib/api.js";
import { pathsFromDrop, basenameOf, dropIntent, type DropIntent } from "../../lib/dropPaths.js";
import { useFileDrag } from "../../lib/useFileDrag.js";
import { useDictation, PTT_LABEL } from "../../lib/useDictation.js";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  appendDraftImage,
} from "../../lib/composerDrafts.js";
import { FilePathPicker } from "./FilePathPicker.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { EffortGauge } from "../ui/EffortGauge.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Chip } from "../ui/Chip.js";
import { Tooltip } from "../ui/Tooltip.js";
import { Spinner } from "../ui/Spinner.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { cn } from "../../lib/cn.js";
import { useChats } from "../../stores/chats.js";
import { useModels } from "../../stores/models.js";
import { useHarnesses } from "../../stores/harnesses.js";
import { actions, uploadChatImage } from "../../lib/actions.js";
import { useAssetSrc } from "../../lib/assetSrc.js";
import { AssetImage } from "../ui/AssetImage.js";
import { useEffectiveEffort } from "../../lib/effectiveEffort.js";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import {
  COMPOSER_CONTROLS,
  hiddenCount,
  useComposerPrefs,
} from "../../lib/composerPrefs.js";
import { EffortChip } from "../agents/runVisuals.js";
import { ContextMeter } from "./ContextMeter.js";

/** The markup editor pulls in two annotation engines — lazy so they stay out of
    the initial bundle and only load when a thumbnail is actually opened. */
const ImageAnnotator = lazy(() => import("./ImageAnnotator.js"));

/**
 * Remembers the model picked per chat for this browser session — a fast optimistic
 * layer over the persisted `chat.model`, so the selector reflects the user's choice
 * instantly across chat switches (local state only re-seeds on a `chat.id` change).
 */
const modelByChat = new Map<string, string>();

/** The three canonical modes surfaced as a segmented control. */
const PRIMARY_MODE_IDS = ["plan", "auto", "edit"];
const PRIMARY_MODE_LABEL: Record<string, string> = { plan: "Plan", auto: "Auto", edit: "Edit" };
const MODE_ICONS: Record<string, ReactNode> = {
  plan: <MapIcon />,
  auto: <Zap />,
  edit: <Pencil />,
};

/**
 * Built-in permission postures the SessionBroker understands via its mode-id
 * fallback map even without a stored ModeConfig — offered in the overflow menu.
 */
const BUILTIN_POSTURES: { id: string; name: string; icon: ReactNode; hint: string }[] = [
  { id: "dontAsk", name: "Don't ask", icon: <BellOff />, hint: "no prompts" },
  { id: "bypass", name: "Bypass", icon: <ShieldOff />, hint: "yolo" },
];

export interface ComposerProps {
  chat: Chat;
  agents: AgentConfig[];
  modes: ModeConfig[];
}

/** Collect image File objects from a paste/drop DataTransfer. */
function imageFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files?.length) {
    for (const f of Array.from(dt.files)) if (f.type.startsWith("image/")) out.push(f);
  }
  if (!out.length && dt.items?.length) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/**
 * What the drop overlay promises, per outcome. Phrased as the result the user
 * gets, not the mechanism: "insert its path" is checkable against what lands in
 * the box a moment later, "read via webUtils" is not.
 */
const DROP_COPY: Record<Exclude<DropIntent, null>, { icon: ReactNode; title: string; hint: string }> =
  {
    image: {
      icon: <ImageIcon />,
      title: "Drop to attach",
      hint: "the image is uploaded and sent with your message",
    },
    path: {
      icon: <FileCode2 />,
      title: "Drop to insert the file path",
      hint: "The agent reads the file itself — nothing is uploaded",
    },
    lookup: {
      icon: <FileSearch />,
      title: "Drop to find this file in the project",
      hint: "the browser hides the real path, so we match on filename",
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

/** Non-image files from a drop — these become PATHS, not uploads. */
function nonImageNamesFrom(dt: DataTransfer | null | undefined): string[] {
  if (!dt?.files?.length) return [];
  return Array.from(dt.files)
    .filter((f) => !f.type.startsWith("image/"))
    .map((f) => f.name);
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

/** The chat composer: TipTap input + attachments + effort/mode/agent + send/steer. */
export function Composer({ chat, agents, modes }: ComposerProps) {
  const upsertChat = useChats((s) => s.upsertChat);
  const harness = chat.harness ?? "claude";
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
  const [isEmpty, setIsEmpty] = useState(true);
  // Two scopes of drag state. `fileDrag` is the whole window — it lights the
  // composer up the moment a file crosses the app, so the user sees where to
  // aim. `over` is this box specifically, which upgrades the same affordance to
  // "release now".
  const fileDrag = useFileDrag();
  const [over, setOver] = useState<DropIntent>(null);
  // The file-path picker, and the query it opens with (a dropped file's basename
  // when a drop was ambiguous, "" for a cold open from the paperclip).
  const [picker, setPicker] = useState<{ query: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModelState] = useState<string>(
    () => modelByChat.get(chat.id) ?? chat.model ?? DEFAULT_MODEL,
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
  const hidden = hiddenCount(visible);
  // Compact toolbar: icon-only controls with tooltips. Chosen automatically —
  // the row collapses to icons the moment its full-label layout would overflow
  // the composer width, and re-expands once there's room again (see below).
  const [compact, setCompact] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // The natural (full-label) content width captured at the instant we collapsed,
  // used as the re-expand threshold so the two states can't flip-flop.
  const expandedWidthRef = useRef(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Latest submit/upload closures, so the (once-configured) TipTap key/paste
  // handlers always call through to fresh state.
  const submitRef = useRef<() => void>(() => {});
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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      Placeholder.configure({
        placeholder:
          "Message agent — ⌘↵ to send, ⇧↵ for newline. Paste an image to attach, drop a file for its path.",
      }),
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
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const clip = (event as ClipboardEvent).clipboardData;
        const files = imageFilesFrom(clip);
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
    editor.commands.setContent(saved.html);
    attachmentsRef.current = saved.images;
    setAttachments(saved.images);
    setEditing(null);
    setUploading(0);
    setError(null);
    setIsEmpty(editor.isEmpty);
    setModelState(modelByChat.get(chat.id) ?? chat.model ?? DEFAULT_MODEL);

    // Land the caret in the composer so an opened chat — brand new, picked from
    // the sidebar, or jumped to from the palette — is typeable immediately. Every
    // open path ends at a `chat.id` change here (or a remount coming back from the
    // git/memory views), so this one effect covers them all. Deferred a frame so
    // the focus lands after the click that opened the chat has settled, and after
    // `setContent` above, which is what makes "end" the end of the restored draft.
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

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
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
        if (stillHere()) setError(e instanceof Error ? e.message : "Image upload failed");
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
   * The drop gave us basenames only (a file-manager drag, which discloses no
   * path) — ask the server which project files could be meant.
   */
  const resolveDroppedNames = async (names: string[]) => {
    const resolved: string[] = [];
    for (const name of names) {
      let matches: IndexedFile[] = [];
      try {
        const res = await api.files.search(chat.id, name, 20);
        matches = res.files.filter(
          (f) => basenameOf(f.rel).toLowerCase() === name.toLowerCase(),
        );
      } catch {
        /* no index (not a checkout, server down) → fall back to the bare name */
      }
      if (matches.length === 1) {
        resolved.push(matches[0]!.abs);
        continue;
      }
      // Ambiguous, and it's the only thing dropped → let them choose instead of
      // guessing. With several files in flight, a modal per file would be worse
      // than the ranked best guess, which is right there in the box to correct.
      if (matches.length > 1 && names.length === 1) {
        setPicker({ query: name });
        return;
      }
      resolved.push(matches[0]?.abs ?? name);
    }
    insertPaths(resolved);
  };

  /**
   * One drop, three outcomes, in descending order of what we actually know:
   * images upload as attachments; a drag that discloses real paths inserts them
   * verbatim; anything else falls back to resolving basenames against the
   * project index. Returns whether the drop was consumed.
   *
   * Which of the last two runs depends entirely on the drag source: only one
   * that publishes a text flavor discloses a path (see pathsFromDrop), so an
   * Explorer drag lands on the index fallback. `dropIntent` predicts the branch
   * so the overlay can say so mid-drag; change one and change the other.
   */
  const handleDrop = (dt: DataTransfer | null): boolean => {
    // Cleared here, not only in the shell's onDrop: a drop landing on the text
    // area is consumed by ProseMirror, which stops propagation before the
    // shell's handler ever runs. Without this the overlay outlives the drop.
    setOver(null);
    const images = imageFilesFrom(dt);
    if (images.length) {
      void addFiles(images);
      return true;
    }
    const paths = pathsFromDrop(dt);
    if (paths.length) {
      insertPaths(paths);
      return true;
    }
    const names = nonImageNamesFrom(dt);
    if (names.length) {
      void resolveDroppedNames(names);
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

  const submit = () => {
    // Serialize with single-newline separators: paragraph breaks join with "\n"
    // (not the default "\n\n", which doubled every newline) and hard breaks — which
    // getText otherwise drops entirely — also become "\n".
    const text =
      editor
        ?.getText({ blockSeparator: "\n", textSerializers: { hardBreak: () => "\n" } })
        .trim() ?? "";
    if ((!text && attachments.length === 0) || uploading > 0) return;

    if (running) {
      // Mid-run: a send steers the live turn. Steering carries text only, so a
      // message with attachments goes as a queued send-message instead.
      if (attachments.length > 0) {
        actions.sendMessage(chat.id, {
          text: text || undefined,
          images: attachments,
          priority: "next",
        });
      } else {
        actions.steer(chat.id, text, "next");
      }
    } else {
      actions.sendMessage(chat.id, {
        text: text || undefined,
        images: attachments.length ? attachments : undefined,
        effort: chat.effort,
      });
    }

    // Sending ends the dictation that composed it — otherwise the tail of the
    // sentence you just sent lands at the top of the next message.
    dictation.stop();
    editor?.commands.clearContent();
    clearDraft(chat.id);
    attachmentsRef.current = [];
    setAttachments([]);
    setEditing(null);
    setIsEmpty(true);
    setError(null);
  };
  submitRef.current = submit;

  const setMode = (modeId: string) => {
    upsertChat({ ...chat, modeId });
    actions.setMode(chat.id, modeId);
  };
  const setEffort = (effort: Effort) => {
    upsertChat({ ...chat, effort });
    actions.setEffort(chat.id, effort);
  };
  const setAgent = (id: string) => {
    const agentId = id === "" ? null : id;
    upsertChat({ ...chat, agentId: agentId ?? undefined });
    actions.setAgent(chat.id, agentId);
  };
  const chooseModel = (m: string) => {
    modelByChat.set(chat.id, m);
    setModelState(m);
    actions.setModel(chat.id, m);
    // A plain model and a custom agent are mutually-exclusive "brains" here —
    // picking a model drops any custom agent so the model actually takes effect.
    if (chat.agentId) setAgent("");
  };

  /* -------------------------------------------------------------- mode wiring */

  const modeSegments = PRIMARY_MODE_IDS.map((id) => ({
    value: id,
    label: modes.find((m) => m.id === id)?.name ?? PRIMARY_MODE_LABEL[id]!,
    icon: MODE_ICONS[id],
  }));

  // Extra postures: custom store modes + the built-in fallbacks the broker maps.
  const postureOptions = [
    ...modes
      .filter((m) => !PRIMARY_MODE_IDS.includes(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        icon: <SlidersHorizontal /> as ReactNode,
        hint: m.permissionMode,
      })),
    ...BUILTIN_POSTURES.filter((b) => !modes.some((m) => m.id === b.id)),
  ];
  const isPosture = !PRIMARY_MODE_IDS.includes(chat.modeId);
  const currentPosture = postureOptions.find((o) => o.id === chat.modeId);

  /* ------------------------------------------------------------- agent wiring */

  const scopedAgents = agents.filter(
    (a) => a.scope !== "project" || a.projectId === chat.projectId,
  );
  const currentAgent = scopedAgents.find((a) => a.id === chat.agentId);

  const canSend = (!isEmpty || attachments.length > 0) && uploading === 0;

  /* ---------------------------------------------------- auto compact toolbar */

  // Decide compact vs full purely from geometry: the toolbar row is `flex-nowrap`
  // with non-shrinking children, so `scrollWidth > clientWidth` means the full
  // layout doesn't fit. On collapse we remember the overflowing width and only
  // re-expand once the row is at least that wide again — a hysteresis band that
  // makes the two states stable instead of oscillating on the boundary pixel.
  const measure = useCallback(() => {
    const el = toolbarRef.current;
    if (!el) return;
    setCompact((cur) => {
      if (!cur) {
        if (el.scrollWidth > el.clientWidth + 1) {
          expandedWidthRef.current = el.scrollWidth;
          return true;
        }
        return cur;
      }
      return el.clientWidth >= expandedWidthRef.current + 4 ? false : cur;
    });
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
      timer = setTimeout(measure, 90);
    };
    measure();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [measure]);

  // The control labels (model / agent / posture name) change the natural width
  // without changing the row's box, so ResizeObserver won't fire — re-measure
  // synchronously whenever they (or the compact state itself) change.
  // Hiding a control changes the row's natural width without changing its box,
  // so `visible` belongs in here alongside the labels.
  useLayoutEffect(() => {
    measure();
  }, [measure, compact, model, chat.modeId, chat.agentId, chat.effort, currentAgent?.name, currentPosture?.name, visible]);

  return (
    <div className="border-t border-line bg-surface/80 px-4 py-3">
      <div className="mx-auto w-full max-w-[860px]">
      {queued > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <Chip tone="accent" icon={<Layers />}>
            {queued} queued
          </Chip>
          <span className="text-xs text-muted">
            steering {queued === 1 ? "message" : "messages"} will inject after the current turn
          </span>
        </div>
      )}

      <div
        className={cn(
          "relative rounded-lg border border-line bg-panel-2 focus-within:border-line-strong",
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
                <div className="leading-tight">
                  <div className="max-w-[120px] truncate text-xs text-secondary">
                    {img.alt ?? filenameOf(img)}
                  </div>
                  <div className="cm-mono !text-2xs text-faint">
                    {img.width && img.height
                      ? `${img.width}×${img.height}`
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

        {/* editor */}
        <div className="cm-prose px-3 py-2.5">
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
            accept="image/*"
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
              come from the server-backed picker instead. */}
          {visible.attach && (
          <Popover
            align="start"
            width={210}
            className="p-1"
            trigger={({ open, toggle }) => (
              <IconButton tip="Attach" active={open} onClick={toggle}>
                <Paperclip />
              </IconButton>
            )}
          >
            {(close) => (
              <div className="flex flex-col">
                <MenuItem
                  icon={<ImageIcon />}
                  hint="upload"
                  onClick={() => {
                    fileInputRef.current?.click();
                    close();
                  }}
                >
                  Attach image
                </MenuItem>
                <MenuItem
                  icon={<FileIcon />}
                  hint="as text"
                  onClick={() => {
                    setPicker({ query: "" });
                    close();
                  }}
                >
                  Insert file path…
                </MenuItem>
              </div>
            )}
          </Popover>
          )}

          {/* Dictation. One control, two gestures: tap to latch the mic on, or
              press and hold to talk only while held (as does holding the
              push-to-talk key anywhere). `onPointerDown` rather than `onClick`
              is what makes the
              hold gesture possible at all — and it starts capturing on the way
              down, so holding doesn't clip the first word. */}
          {visible.dictate && (
          <IconButton
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

          {visible.mode && (
            <SegmentedControl
              segments={modeSegments}
              value={chat.modeId}
              onChange={setMode}
              compact={compact}
            />
          )}

          {/* overflow: custom modes + dontAsk / bypass postures */}
          {visible.posture && (
          <Popover
            align="start"
            width={210}
            className="p-1"
            trigger={({ open, toggle }) => {
              const btn = (
                <button
                  onClick={toggle}
                  aria-expanded={open}
                  aria-label="More permission postures"
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs " +
                      "font-medium transition-colors [&_svg]:size-3",
                    isPosture
                      ? "border-accent-line bg-accent-ghost text-accent-hi"
                      : "border-line bg-inset text-muted hover:border-line-strong hover:text-secondary",
                    open && !isPosture && "border-line-strong text-secondary",
                  )}
                >
                  {currentPosture?.icon ?? <SlidersHorizontal />}
                  {!compact && isPosture && (
                    <span className="max-w-[84px] truncate">
                      {currentPosture?.name ?? chat.modeId}
                    </span>
                  )}
                </button>
              );
              return compact ? (
                <Tooltip
                  label={
                    isPosture
                      ? `Posture — ${currentPosture?.name ?? chat.modeId}`
                      : "More permission postures"
                  }
                >
                  {btn}
                </Tooltip>
              ) : (
                btn
              );
            }}
          >
            {(close) => (
              <div className="flex flex-col">
                <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">
                  Permission posture
                </div>
                {postureOptions.map((o) => (
                  <MenuItem
                    key={o.id}
                    icon={o.icon}
                    hint={o.hint}
                    active={o.id === chat.modeId}
                    onClick={() => {
                      setMode(o.id);
                      close();
                    }}
                  >
                    <span className="flex items-center gap-2">
                      {o.name}
                      {o.id === chat.modeId && <Check className="size-3 text-accent" />}
                    </span>
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
          )}

          {visible.effort && (
            <>
              <Select
                options={effortOptions}
                value={chat.effort}
                onChange={setEffort}
                leftIcon={<EffortGauge effort={chat.effort} />}
                label="effort"
                width={172}
                compact={compact}
              />

              {/* Only shown when the level that RAN differs from the one picked — an
                  agent pinning its own, or a model silently downgrading it. Silent
                  otherwise, so the row stays quiet in the normal case. */}
              {effectiveEffort && effectiveEffort !== chat.effort && (
                <EffortChip effort={effectiveEffort} label="running at" />
              )}
            </>
          )}

          {/* model / agent — the session "brain": a custom agent's name when one
              is picked (secondary state), otherwise the active model label so it
              never misleadingly reads "No agent" while a model is running. */}
          {visible.brain && (
          <Popover
            align="start"
            width={210}
            className="p-1"
            trigger={({ open, toggle }) => {
              const btn = (
                <button
                  onClick={toggle}
                  aria-expanded={open}
                  aria-label={currentAgent ? "Agent" : "Model"}
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-md border text-sm " +
                      "font-medium transition-colors [&_svg]:size-3.5",
                    compact ? "justify-center px-1.5" : "px-2",
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
                  {!compact && (
                    <>
                      <span className="max-w-[120px] truncate">
                        {currentAgent ? currentAgent.name : modelLabelOf(model)}
                      </span>
                      <ChevronsUpDown className="ml-auto text-faint" />
                    </>
                  )}
                </button>
              );
              return compact ? (
                <Tooltip
                  label={
                    currentAgent
                      ? `Agent — ${currentAgent.name}`
                      : `Model — ${modelLabelOf(model)}`
                  }
                >
                  {btn}
                </Tooltip>
              ) : (
                btn
              );
            }}
          >
            {(close) => (
              <div className="flex flex-col">
                <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">
                  Provider
                </div>
                {harnesses.map((candidate) => (
                  <MenuItem
                    key={candidate.kind}
                    icon={<Cpu />}
                    active={candidate.kind === harness}
                    disabled={!candidate.runtime.available}
                    hint={candidate.runtime.available ? candidate.runtime.version : "not installed"}
                    onClick={() => {
                      if (!candidate.runtime.available || candidate.kind === harness) return;
                      modelByChat.delete(chat.id);
                      setModelState("");
                      upsertChat({
                        ...chat,
                        harness: candidate.kind,
                        sessionId: undefined,
                        model: undefined,
                        status: "idle",
                      });
                      actions.setHarness(chat.id, candidate.kind);
                      close();
                    }}
                  >
                    <span className="flex items-center gap-2 capitalize">
                      {candidate.kind}
                      {candidate.kind === harness && <Check className="size-3 text-accent" />}
                    </span>
                  </MenuItem>
                ))}
                <div className="my-1 h-px bg-line" />
                <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">
                  Model · {harness}
                </div>
                {models.map((m) => (
                  <MenuItem
                    key={m.value}
                    icon={<Cpu />}
                    hint={m.hint}
                    title={m.description}
                    active={m === selectedModel}
                    onClick={() => {
                      chooseModel(m.value);
                      close();
                    }}
                  >
                    <span className="flex items-center gap-2">
                      {m.label}
                      {m === selectedModel && <Check className="size-3 text-accent" />}
                    </span>
                  </MenuItem>
                ))}
                {capabilities?.subagents !== false && scopedAgents.length > 0 && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">
                      Custom agent
                    </div>
                    {scopedAgents.map((a) => (
                      <MenuItem
                        key={a.id}
                        icon={<Bot />}
                        active={a.id === chat.agentId}
                        onClick={() => {
                          setAgent(a.id);
                          close();
                        }}
                      >
                        <span className="flex items-center gap-2">
                          {a.name}
                          {a.id === chat.agentId && <Check className="size-3 text-accent" />}
                        </span>
                      </MenuItem>
                    ))}
                  </>
                )}
              </div>
            )}
          </Popover>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* Which of the above to draw. Last in the row and always present —
                it's the only way back from a toolbar you've emptied. */}
            <Popover
              align="end"
              width={264}
              className="p-1"
              trigger={({ open, toggle }) => (
                <IconButton
                  tip={hidden ? `Toolbar — ${hidden} hidden` : "Choose toolbar controls"}
                  active={open}
                  onClick={toggle}
                >
                  <Settings2 />
                </IconButton>
              )}
            >
              {() => (
                <div className="flex flex-col">
                  <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">
                    Show in composer
                  </div>
                  {COMPOSER_CONTROLS.map((c) => (
                    <MenuItem
                      key={c.id}
                      icon={
                        visible[c.id] ? <Check className="text-accent" /> : <span className="size-3" />
                      }
                      hint={c.hint}
                      onClick={() => toggleControl(c.id)}
                    >
                      <span className={visible[c.id] ? "text-primary" : "text-muted"}>
                        {c.label}
                      </span>
                    </MenuItem>
                  ))}
                  {hidden > 0 && (
                    <>
                      <div className="my-1 h-px bg-line" />
                      <MenuItem icon={<Eye />} onClick={showAllControls}>
                        Show all
                      </MenuItem>
                    </>
                  )}
                </div>
              )}
            </Popover>
            {visible.context && (
              <ContextMeter chatId={chat.id} model={model} iconOnly={compact} />
            )}
            {/* Stop the live turn — interrupts the running query server-side.
                Shown only mid-run, right beside Send so it's where the eye is. */}
            {running && (
              <Button
                type="button"
                variant="danger"
                size="md"
                leftIcon={<Square />}
                onClick={() => actions.interrupt(chat.id)}
                title="Stop the current turn"
              >
                {compact ? "" : "Stop"}
              </Button>
            )}
            {/* Gate by look, not the native `disabled` attribute: a disabled
                button swallows the click that lands in the same frame as the last
                keystroke (React commits `canSend` a tick later), which is why
                clicking Send used to no-op while ⌘↵ — which bypasses the button —
                worked. `submit` reads the live editor text and self-guards, so the
                click now always takes the exact same path as the shortcut. */}
            <Button
              type="button"
              variant="primary"
              size="md"
              rightIcon={running ? <Layers /> : <ArrowUp />}
              onClick={submit}
              aria-disabled={!canSend}
              className={cn(!canSend && "opacity-45")}
            >
              {running ? "Queue" : "Send"}
            </Button>
          </div>
        </div>
      </div>

      </div>

      {picker && (
        <FilePathPicker
          chatId={chat.id}
          initialQuery={picker.query}
          onPick={(f) => {
            setPicker(null);
            insertPaths([f.abs]);
          }}
          onClose={() => setPicker(null)}
        />
      )}

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
  );
}
