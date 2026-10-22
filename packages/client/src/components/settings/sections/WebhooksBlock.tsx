/**
 * Settings → Integrations → Webhooks: the block for outbound, signed POSTs of
 * bus events. Lives beside `TokensBlock` in `IntegrationsSection.tsx`.
 *
 * Nothing here rides the app-settings draft or the save bar: a subscription is
 * its own row with its own routes, and it takes effect the moment the dialog
 * confirms it, the way a push device or a token does.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Plus, RefreshCw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import {
  WEBHOOK_ATTENTION_KINDS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_ROW_KINDS,
  type WebhookDelivery,
  type WebhookFilter,
  type WebhookSubscriptionInput,
  type WebhookSubscriptionPublic,
} from "@dispatch/shared";
import { api } from "../../../lib/api.js";
import { cn } from "../../../lib/cn.js";
import { copyToClipboard } from "../../../lib/clipboard.js";
import { useNotices } from "../../../stores/notices.js";
import { useRealProjects } from "../../../stores/projects.js";
import { Field, InlineError, Modal, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { IconButton } from "../../ui/IconButton.js";
import { Spinner } from "../../ui/Spinner.js";
import { Switch } from "../../ui/Switch.js";

/* ------------------------------------------------------------- helpers */

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "All events" / "3 events" — the one-line reading of a filter list. */
function summary(list: readonly string[] | undefined, noun: string): string {
  if (!list?.length) return `All ${noun}`;
  return list.length === 1 ? list[0]! : `${list.length} ${noun}`;
}

const STATUS_TONE = { pending: "info", delivered: "success", dead: "danger" } as const;

/* --------------------------------------------------------------- block */

export function WebhooksBlock() {
  const pushToast = useNotices((s) => s.push);
  const [subs, setSubs] = useState<WebhookSubscriptionPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WebhookSubscriptionPublic | "new" | null>(null);
  /** A secret just minted or rotated — shown until dismissed, never fetched again. */
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null);

  const load = useCallback(() => {
    api.webhooks.list().then(
      (rows) => {
        setSubs(rows);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, []);
  useEffect(load, [load]);

  const toggle = async (sub: WebhookSubscriptionPublic, active: boolean) => {
    try {
      await api.webhooks.update(sub.id, { active });
      load();
    } catch (e) {
      pushToast({ level: "error", text: `Could not update "${sub.name}": ${errorText(e)}` });
    }
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-secondary">Webhooks</p>
          <p className="text-2xs text-faint">
            A signed POST per event to a URL you own: <span className="cm-mono">X-Dispatch-Signature: t=…,v1=…</span>
          </p>
        </div>
        <Button leftIcon={<Plus />} onClick={() => setEditing("new")}>
          Add webhook
        </Button>
      </div>
      <p className="mb-2 mt-2 text-xs leading-snug text-faint">
        The signature is an HMAC-SHA256 over <code className="text-fg">{"<t>.<body>"}</code> with
        the webhook's secret. Failed deliveries retry over the following forty minutes and a week
        of history is kept per webhook; twenty deliveries that fail every retry pause it until you
        turn it back on.
      </p>
      {error ? <InlineError message={error} /> : null}
      {subs === null && !error ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Spinner size={12} /> Loading…
        </div>
      ) : subs && subs.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
          No webhooks yet. Add one to POST chat, attention or PR events to a URL you own.
        </div>
      ) : (
        <ul className="space-y-2">
          {subs?.map((sub) => (
            <li key={sub.id}>
              <SubscriptionCard
                sub={sub}
                revealedSecret={revealed?.id === sub.id ? revealed.secret : null}
                onDismissSecret={() => setRevealed(null)}
                onToggle={(v) => void toggle(sub, v)}
                onEdit={() => setEditing(sub)}
                onChanged={load}
              />
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <WebhookEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, secret) => {
            setEditing(null);
            if (secret) setRevealed({ id: saved.id, secret });
            load();
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- card */

function SubscriptionCard({
  sub,
  revealedSecret,
  onDismissSecret,
  onToggle,
  onEdit,
  onChanged,
}: {
  sub: WebhookSubscriptionPublic;
  revealedSecret: string | null;
  onDismissSecret: () => void;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const pushToast = useNotices((s) => s.push);
  const projects = useRealProjects();
  const [showLog, setShowLog] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logKey, setLogKey] = useState(0);

  const test = async () => {
    setTesting(true);
    try {
      const d = await api.webhooks.test(sub.id);
      if (d.status === "delivered") {
        pushToast({ level: "info", text: `"${sub.name}" answered HTTP ${d.lastStatus ?? "2xx"}.` });
      } else if (d.status === "dead") {
        // A paused webhook gets one try and no retry schedule (see the service).
        pushToast({
          level: "warn",
          text: `"${sub.name}" did not accept the test (${d.lastError ?? "no response"}). It is paused, so there is no retry — fix the endpoint and send another.`,
        });
      } else {
        pushToast({
          level: "warn",
          text: `"${sub.name}" did not accept the test (${d.lastError ?? "no response"}). Retrying in the background.`,
        });
      }
      setShowLog(true);
      setLogKey((k) => k + 1);
      onChanged();
    } catch (e) {
      pushToast({ level: "error", text: `Test failed: ${errorText(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    try {
      await api.webhooks.remove(sub.id);
      onChanged();
    } catch (e) {
      pushToast({ level: "error", text: `Could not delete: ${errorText(e)}` });
    }
  };

  const f = sub.filters;
  const paused = !sub.active && !!sub.pausedReason;

  return (
    <div className="rounded-md border border-line bg-inset/40 px-2.5 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <WebhookIcon className="size-3.5 shrink-0 text-accent" />
            <span className="truncate text-sm font-medium text-secondary">{sub.name}</span>
            {paused ? <Chip tone="warn">Paused</Chip> : null}
            {sub.consecutiveFailures > 0 && !paused ? (
              <Chip tone="warn">{sub.consecutiveFailures} failing</Chip>
            ) : null}
          </div>
          <div className="cm-mono mt-0.5 truncate text-xs text-faint" title={sub.url}>
            {sub.url}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Chip tone="info" mono>
              {summary(f.events, "events")}
            </Chip>
            {f.events?.length === 0 || !f.events || f.events.includes("chat-message") ? (
              f.rowKinds?.length ? (
                <Chip tone="neutral" mono>
                  rows: {summary(f.rowKinds, "kinds")}
                </Chip>
              ) : null
            ) : null}
            {f.attentionKinds?.length ? (
              <Chip tone="neutral" mono>
                attention: {summary(f.attentionKinds, "kinds")}
              </Chip>
            ) : null}
            <Chip tone="neutral">
              {summary(
                // Names, not ids: the id is what the filter stores, but nobody
                // recognises their project by it. A project since removed keeps
                // its id so the chip still says something is narrowed.
                f.projectIds?.map((id) => projects.find((p) => p.id === id)?.name ?? id),
                "projects",
              )}
            </Chip>
            {f.chatIds?.length ? <Chip tone="neutral">{summary(f.chatIds, "chats")}</Chip> : null}
            {sub.createdBy !== "user" ? <Chip tone="agent">token</Chip> : null}
          </div>
          {paused ? (
            <p className="mt-1.5 text-xs leading-snug text-warn">{sub.pausedReason}</p>
          ) : null}
          {sub.lastDeliveryAt ? (
            <p className="mt-1 text-2xs text-faint">
              Last delivered {new Date(sub.lastDeliveryAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <Switch
          checked={sub.active}
          onChange={onToggle}
          label={sub.active ? "On" : paused ? "Paused" : "Off"}
        />
      </div>

      {revealedSecret ? <SecretReveal secret={revealedSecret} onDismiss={onDismissSecret} /> : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
        <Button size="sm" variant="ghost" leftIcon={testing ? <Spinner size={12} /> : <Send />} disabled={testing} onClick={() => void test()}>
          {testing ? "Sending…" : "Send test"}
        </Button>
        <Button size="sm" variant={showLog ? "toggle" : "ghost"} aria-pressed={showLog} onClick={() => setShowLog((v) => !v)}>
          Deliveries
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <span className="ml-auto" />
        {confirmDelete ? (
          <>
            <Button size="sm" variant="link" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button size="sm" variant="danger" leftIcon={<Trash2 />} onClick={() => void remove()}>
              Delete webhook
            </Button>
          </>
        ) : (
          <IconButton tip="Delete webhook" onClick={() => setConfirmDelete(true)}>
            <Trash2 />
          </IconButton>
        )}
      </div>

      {showLog ? <DeliveryLog key={logKey} subscriptionId={sub.id} onChanged={onChanged} /> : null}
    </div>
  );
}

/** The secret, once. There is no route that returns it again. */
function SecretReveal({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const pushToast = useNotices((s) => s.push);
  return (
    <div className="mt-2 rounded-md border border-accent-line bg-accent-ghost px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-accent-hi">Signing secret — shown once</span>
        <div className="flex items-center gap-1">
          <IconButton
            tip="Copy secret"
            onClick={() =>
              void copyToClipboard(secret).then((ok) =>
                pushToast({ level: ok ? "info" : "error", text: ok ? "Secret copied" : "Copy failed" }),
              )
            }
          >
            <Copy />
          </IconButton>
          <Button size="sm" variant="link" onClick={onDismiss}>
            Done
          </Button>
        </div>
      </div>
      <code className="cm-mono mt-1 block select-all break-all text-xs text-primary">{secret}</code>
      <p className="mt-1 text-2xs text-faint">
        Put this in your receiver now. Dispatch does not show it again; rotate it from Edit if it is
        lost.
      </p>
    </div>
  );
}

/* --------------------------------------------------------- delivery log */

function DeliveryLog({ subscriptionId, onChanged }: { subscriptionId: string; onChanged: () => void }) {
  const pushToast = useNotices((s) => s.push);
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.webhooks.deliveries(subscriptionId, 50).then(
      (r) => {
        setRows(r);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [subscriptionId]);
  useEffect(load, [load]);

  const redeliver = async (d: WebhookDelivery) => {
    setBusy(d.id);
    try {
      await api.webhooks.redeliver(subscriptionId, d.id);
      load();
      onChanged();
    } catch (e) {
      pushToast({ level: "error", text: `Redeliver failed: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-faint">Recent deliveries</span>
        <IconButton tip="Refresh" onClick={load}>
          <RefreshCw />
        </IconButton>
      </div>
      {error ? <InlineError message={error} /> : null}
      {rows === null && !error ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted">
          <Spinner size={12} /> Loading…
        </div>
      ) : rows && rows.length === 0 ? (
        <p className="py-1 text-xs text-faint">Nothing delivered yet.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows?.map((d) => (
            <li key={d.id} className="flex items-center gap-2 py-1 text-xs">
              <Chip tone={STATUS_TONE[d.status]}>{d.status}</Chip>
              <span className="cm-mono truncate text-secondary">{d.eventType}</span>
              <span className="text-faint">
                {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                {d.lastStatus !== undefined ? ` · HTTP ${d.lastStatus}` : d.lastError ? ` · ${d.lastError}` : ""}
              </span>
              <span className="ml-auto shrink-0 text-2xs text-faint" title={new Date(d.createdAt).toISOString()}>
                {new Date(d.updatedAt).toLocaleTimeString()}
              </span>
              {d.status !== "pending" ? (
                <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => void redeliver(d)}>
                  {busy === d.id ? "Sending…" : "Redeliver"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- editor */

/**
 * One list of options behind an "all / only these" switch. The switch exists
 * because an empty list means ALL — the filter's unset default — and a grid of
 * thirty unchecked boxes that quietly means "everything" is a trap.
 */
function PickList({
  label,
  hint,
  options,
  value,
  onChange,
  mono,
}: {
  label: string;
  hint?: string;
  options: Array<{ id: string; label: string }>;
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  mono?: boolean;
}) {
  const narrowed = !!value?.length;
  const set = new Set(value ?? []);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-secondary">{label}</span>
        <Switch
          checked={narrowed}
          onChange={(v) => onChange(v ? [options[0]?.id ?? ""].filter(Boolean) : undefined)}
          label={narrowed ? "Only these" : "All"}
        />
      </div>
      {hint ? <p className="mb-1 text-2xs text-faint">{hint}</p> : null}
      {narrowed ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-line bg-inset/40 px-2.5 py-2 sm:grid-cols-3">
          {options.map((o) => (
            <label key={o.id} className={cn("flex items-center gap-2 text-xs text-secondary", mono && "cm-mono")}>
              <input
                type="checkbox"
                checked={set.has(o.id)}
                onChange={(e) => {
                  const next = new Set(set);
                  if (e.target.checked) next.add(o.id);
                  else next.delete(o.id);
                  onChange([...next]);
                }}
              />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WebhookEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: WebhookSubscriptionPublic | null;
  onClose: () => void;
  onSaved: (saved: WebhookSubscriptionPublic, secret?: string) => void;
}) {
  const projects = useRealProjects();
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [secret, setSecret] = useState("");
  const [active, setActive] = useState(initial?.active ?? true);
  const [filters, setFilters] = useState<WebhookFilter>(initial?.filters ?? {});
  const [chatIdsText, setChatIdsText] = useState((initial?.filters.chatIds ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eventOptions = useMemo(() => WEBHOOK_EVENT_TYPES.map((t) => ({ id: t, label: t })), []);
  const rowOptions = useMemo(() => WEBHOOK_ROW_KINDS.map((k) => ({ id: k, label: k })), []);
  const attentionOptions = useMemo(
    () => WEBHOOK_ATTENTION_KINDS.map((k) => ({ id: k, label: k })),
    [],
  );
  const projectOptions = useMemo(() => projects.map((p) => ({ id: p.id, label: p.name })), [projects]);

  const wantsChatMessage = !filters.events?.length || filters.events.includes("chat-message");
  const wantsAttention = !filters.events?.length || filters.events.includes("attention-add");

  const save = async () => {
    setBusy(true);
    setError(null);
    const chatIds = chatIdsText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const body: WebhookSubscriptionInput = {
      name: name.trim(),
      url: url.trim(),
      active,
      filters: { ...filters, chatIds: chatIds.length ? chatIds : undefined },
      ...(secret.trim() ? { secret: secret.trim() } : {}),
    };
    try {
      if (initial) {
        const saved = await api.webhooks.update(initial.id, body);
        onSaved(saved, saved.secret);
      } else {
        const saved = await api.webhooks.create(body);
        onSaved(saved, saved.secret);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const valid = name.trim().length > 0 && /^https?:\/\/\S+$/i.test(url.trim());

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      icon={<WebhookIcon />}
      title={initial ? `Edit "${initial.name}"` : "Add webhook"}
      description={
        initial
          ? "Changes apply to the next delivery. Deliveries already in flight keep retrying as they were."
          : "Dispatch generates a signing secret and shows it once after you save."
      }
      footer={
        <>
          <Button variant="link" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            leftIcon={busy ? <Spinner size={12} /> : undefined}
            onClick={() => void save()}
          >
            {initial ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Grok bot" autoFocus />
        </Field>
        <Field label="URL" hint="POST target, http or https" required>
          <TextInput
            mono
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hooks/dispatch"
          />
        </Field>
        <Field
          label={initial ? "Rotate secret" : "Secret"}
          hint={initial ? "blank keeps the current one" : "blank = generate"}
        >
          <TextInput
            mono
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={initial ? "leave blank to keep" : "at least 8 characters, or leave blank"}
            autoComplete="off"
          />
        </Field>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-secondary">Deliver events</span>
          <Switch checked={active} onChange={setActive} label={active ? "On" : "Off"} />
        </div>

        <div className="space-y-3 border-t border-line pt-3">
          <PickList
            label="Events"
            hint="Wire event types as the receiver will see them in X-Dispatch-Event. chat-settled fires once a turn has actually finished, after queued messages flush."
            options={eventOptions}
            value={filters.events}
            onChange={(v) => setFilters({ ...filters, events: v as WebhookFilter["events"] })}
            mono
          />
          {wantsChatMessage ? (
            <PickList
              label="Transcript row kinds"
              hint="Narrows chat-message only."
              options={rowOptions}
              value={filters.rowKinds}
              onChange={(v) => setFilters({ ...filters, rowKinds: v as WebhookFilter["rowKinds"] })}
              mono
            />
          ) : null}
          {wantsAttention ? (
            <PickList
              label="Attention kinds"
              hint="Narrows attention-add only."
              options={attentionOptions}
              value={filters.attentionKinds}
              onChange={(v) =>
                setFilters({ ...filters, attentionKinds: v as WebhookFilter["attentionKinds"] })
              }
              mono
            />
          ) : null}
          {projectOptions.length ? (
            <PickList
              label="Projects"
              options={projectOptions}
              value={filters.projectIds}
              onChange={(v) => setFilters({ ...filters, projectIds: v })}
            />
          ) : null}
          <Field label="Chat IDs" hint="optional, comma-separated">
            <TextInput
              mono
              value={chatIdsText}
              onChange={(e) => setChatIdsText(e.target.value)}
              placeholder="leave blank for every chat"
            />
          </Field>
        </div>
        {error ? <InlineError message={error} /> : null}
      </div>
    </Modal>
  );
}
