/**
 * The state behind the composer's `/` menu — kept out of `Composer.tsx`, which
 * is already 1600 lines and owns six other concerns.
 *
 * The catalog is fetched lazily: nothing is requested until the user actually
 * types a slash. A composer that pre-fetches on mount would issue one request
 * per chat switch for a menu most messages never open. It's re-fetched whenever
 * the menu re-opens after being closed, which is what makes a skill authored
 * seconds ago by `config_write` appear without a reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SlashCommandInfo } from "@dispatch/shared";
import { matchSlashCommands } from "@dispatch/shared";
import { api } from "../../lib/api.js";

/**
 * The message-so-far shapes that open the menu: a lone `/`, or a slash followed
 * by a command-name token and nothing else.
 *
 * Anchored at both ends on purpose. A slash command only expands when it starts
 * the message, and a space ENDS the name — once you're typing arguments the list
 * has nothing left to filter on, so it gets out of the way.
 */
export const SLASH_TOKEN_RE = /^\/([a-zA-Z0-9:_-]*)$/;

/** The subset of a keyboard event {@link slashKeyAction} judges. */
export interface SlashKeyEvent {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * What an open `/` menu should do with a keystroke, or null to let it through.
 *
 * Pure and exported so it can be tested without a DOM — the composer's real
 * handler is inside a TipTap `handleKeyDown` closure that the node-env client
 * suite cannot reach, and this is exactly the logic that is easy to get subtly
 * wrong. It already was: "a bare Enter commits the row" was implemented as
 * `!shiftKey`, which also matched **Ctrl/Cmd+Enter** — the composer's only SEND
 * shortcut, since plain Enter inserts a newline here. Typing `/review` in full
 * and pressing Ctrl+Enter re-inserted the command instead of sending it.
 *
 * `"commit"` therefore requires NO modifier at all.
 */
export function slashKeyAction(event: SlashKeyEvent): "commit" | "next" | "prev" | "close" | null {
  if (event.key === "Escape") return "close";
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "prev";
  if (event.key === "Tab" && !event.shiftKey) return "commit";
  const bare = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (event.key === "Enter" && bare) return "commit";
  return null;
}

export interface SlashCommandsState {
  /** Non-null while the menu is open — the text typed after the slash. */
  query: string | null;
  /** Ranked matches for `query`. Empty ⇒ nothing to show. */
  matches: SlashCommandInfo[];
  /** Highlighted row. Always a valid index into `matches` when it's non-empty. */
  active: number;
  builtinsKnown: boolean;
  setActive: (index: number) => void;
  /** Feed the editor's current plain text; opens/filters/closes the menu. */
  onText: (text: string) => void;
  /** Close without picking (Escape, blur, send). */
  close: () => void;
  /** Move the highlight by ±1, wrapping. Returns false when the menu is shut. */
  move: (delta: number) => boolean;
  /** The row Enter/Tab would take, or null when the menu is shut/empty. */
  current: () => SlashCommandInfo | null;
}

export function useSlashCommands(chatId: string): SlashCommandsState {
  const [query, setQuery] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);
  const [builtinsKnown, setBuiltinsKnown] = useState(true);
  const [active, setActive] = useState(0);
  /** Guards against a slow response for a chat the user has already left. */
  const chatRef = useRef(chatId);
  chatRef.current = chatId;
  /** True while a fetch for the current open is in flight or already done. */
  const loadedFor = useRef<string | null>(null);

  // A chat switch invalidates everything: different cwd, different skills.
  useEffect(() => {
    setQuery(null);
    setCommands([]);
    loadedFor.current = null;
  }, [chatId]);

  const load = useCallback(() => {
    if (loadedFor.current === chatId) return;
    loadedFor.current = chatId;
    const id = chatId;
    void api
      .commands(id)
      .then((catalog) => {
        if (chatRef.current !== id) return;
        setCommands(catalog.commands);
        setBuiltinsKnown(catalog.builtinsKnown);
      })
      .catch(() => {
        if (chatRef.current !== id) return;
        // A failed fetch leaves the menu empty, which renders as nothing at all
        // — the composer keeps working and the slash is just text.
        setCommands([]);
      });
  }, [chatId]);

  const onText = useCallback(
    (text: string) => {
      const match = SLASH_TOKEN_RE.exec(text);
      if (!match) {
        setQuery((prev) => {
          if (prev !== null) loadedFor.current = null;
          return null;
        });
        return;
      }
      load();
      setQuery(match[1] ?? "");
      setActive(0);
    },
    [load],
  );

  const close = useCallback(() => {
    setQuery(null);
    loadedFor.current = null;
  }, []);

  const matches = query === null ? [] : matchSlashCommands(commands, query);
  // Clamp rather than reset: the list shrinks as you type, and a highlight left
  // past the end would make Enter insert nothing.
  const activeIndex = matches.length ? Math.min(active, matches.length - 1) : 0;

  const move = useCallback(
    (delta: number) => {
      if (query === null || !matches.length) return false;
      setActive((prev) => {
        const next = (prev + delta) % matches.length;
        return next < 0 ? next + matches.length : next;
      });
      return true;
    },
    [query, matches.length],
  );

  const current = useCallback(
    () => (query !== null && matches.length ? (matches[activeIndex] ?? null) : null),
    [query, matches, activeIndex],
  );

  return {
    query,
    matches,
    active: activeIndex,
    builtinsKnown,
    setActive,
    onText,
    close,
    move,
    current,
  };
}
