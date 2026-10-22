// The client half of hello-slot — what docs/plugins.md calls `client/index.js`
// once vite.config.mjs has built it. One export, `activate(host)`, and every
// seam the client host offers exercised once:
//
//   slots.composerControl  a Sparkles icon in the toolbar ladder; its options-
//                          menu drill-in counts, greets and pings the server
//   slots.chatBadge        the count, as a chip in the chat header
//   slots.settingsSection  Settings → "Hello (slot)", with a kit Toggle/Field
//   chat.setExt            the count lives in `chat.ext["hello-slot"]`
//   events.onPlugin        the server half's plugin-events become toasts
//   api.fetch              `/api/plugins/hello-slot/ping`, authenticated
//
// `react` and `lucide-react` are imported normally; the build resolves them
// to the host's copies (see vite.config.mjs). No `<button>` anywhere — the
// kit is the whole surface, which is also what keeps a plugin looking like
// the app around it.
import { useEffect, useState } from "react";
import { Hand, Radio, Sparkles } from "lucide-react";
import type { ClientHost, PluginChatRef } from "@dispatch/shared";

interface HelloExt {
  count?: number;
}

function countOf(host: ClientHost, chat: PluginChatRef | undefined): number {
  const ext = chat?.ext?.[host.pluginId] as HelloExt | undefined;
  return typeof ext?.count === "number" ? ext.count : 0;
}

/**
 * The chat on screen, re-read when the server says it changed. `chat-update`
 * is what carries a new `ext`, so this is how a control sees its own write
 * land — in this tab and in every other.
 */
function useCurrentChat(host: ClientHost): PluginChatRef | undefined {
  const [chat, setChat] = useState(() => host.chat.current());
  useEffect(() => {
    const refresh = () => setChat(host.chat.current());
    const offs = [host.events.on("chat-update", refresh), host.events.on("chat-status", refresh)];
    return () => offs.forEach((off) => off());
  }, [host]);
  return chat;
}

function bump(host: ClientHost, chat: PluginChatRef | undefined): void {
  if (!chat) return;
  void host.chat.setExt(chat.id, { count: countOf(host, chat) + 1 });
}

/** The toolbar form: an icon that counts. The ladder sizes it; this just draws it. */
function HelloControl({ host }: { host: ClientHost }) {
  const { IconButton } = host.ui;
  const chat = useCurrentChat(host);
  const n = countOf(host, chat);
  return (
    <IconButton
      tip={n ? `Hello — ${n} on this chat` : "Hello — say it"}
      active={n > 0}
      aria-label="Hello"
      onClick={() => bump(host, chat)}
    >
      <Sparkles />
    </IconButton>
  );
}

/** The options-menu drill-in: rows, never a popover (on a phone this is inside a sheet). */
function HelloMenu({ host }: { host: ClientHost }) {
  const { MenuItem } = host.ui;
  const chat = useCurrentChat(host);
  const n = countOf(host, chat);
  return (
    <>
      <MenuItem icon={<Sparkles />} hint={`${n} so far`} onClick={() => bump(host, chat)}>
        Count on this chat
      </MenuItem>
      <MenuItem icon={<Hand />} hint="a toast" onClick={() => host.toast("Hello from hello-slot")}>
        Say hello
      </MenuItem>
      <MenuItem
        icon={<Radio />}
        hint="server round trip"
        onClick={() => {
          // The server half answers with ctx.emit → plugin-event → the
          // onPlugin listener in activate() → a toast.
          void host.api.fetch("ping", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chatId: chat?.id }),
          });
        }}
      >
        Ping the server
      </MenuItem>
    </>
  );
}

function HelloBadge({ host, chat }: { host: ClientHost; chat: PluginChatRef }) {
  const n = countOf(host, chat);
  if (!n) return null;
  return (
    <host.ui.Tooltip label={`hello-slot counted ${n} on this chat`}>
      <span className="inline-flex h-5 items-center gap-1 rounded-sm border border-line px-1.5 text-xs text-secondary">
        <Sparkles className="size-3" />
        {n}
      </span>
    </host.ui.Tooltip>
  );
}

function HelloSettings({ host }: { host: ClientHost }) {
  const { Button, Field, Toggle } = host.ui;
  const [loud, setLoud] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">
        A section a plugin registered. Everything here is the host&apos;s kit — the same
        components the rest of Settings is built from.
      </p>
      <Field label="Greeting" hint="this browser only">
        <Toggle checked={loud} onChange={setLoud} label={loud ? "Loud" : "Quiet"} />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => host.toast(loud ? "HELLO!" : "hello", { kind: "info" })}
        >
          Say it
        </Button>
        <Button
          size="sm"
          onClick={() => {
            void host.api
              .fetch("hello")
              .then((r) => r.text())
              .then(setAnswer, (err: unknown) => setAnswer(String(err)));
          }}
        >
          Ask the server half
        </Button>
      </div>
      {answer && <pre className="cm-mono text-xs text-secondary">{answer}</pre>}
    </div>
  );
}

export function activate(host: ClientHost): void {
  host.slots.composerControl({
    id: "hello",
    label: "Hello",
    hint: "the example control",
    icon: <Sparkles />,
    priority: 1,
    render: () => <HelloControl host={host} />,
    menu: <HelloMenu host={host} />,
  });
  host.slots.chatBadge({ render: (chat) => <HelloBadge host={host} chat={chat} /> });
  host.slots.settingsSection({
    id: "hello",
    label: "Hello (slot)",
    blurb: "The example plugin's page",
    icon: Sparkles,
    render: () => <HelloSettings host={host} />,
  });
  host.events.onPlugin((payload) => {
    host.toast(`hello-slot: ${JSON.stringify(payload)}`);
  });
}
