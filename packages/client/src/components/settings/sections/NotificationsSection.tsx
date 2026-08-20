import { useEffect } from "react";
import { Field, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { SectionLabel } from "../../ui/Panel.js";
import { Switch } from "../../ui/Switch.js";
import { useBrowserNotify, notifyUnavailableReason } from "../../../lib/browserNotify.js";
import {
  useWebPush,
  pushUnavailableReason,
  deviceTimeZone,
} from "../../../lib/webPush.js";
import type { NotificationPrefs } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import type { AppPaneProps } from "./types.js";

/**
 * Everything on this pane except the webhook block is per-DEVICE and lives in
 * this browser's localStorage, NOT in server-side AppSettings — which is why it
 * takes effect on click and ignores the save bar at the bottom of the page. The
 * permission a notification depends on is granted per origin per browser, so
 * "on" can only ever mean "on here"; persisting it centrally would promise every
 * device what one device chose.
 *
 * The one wrinkle: the FILTERS are also uploaded to the server. iOS revokes a
 * push subscription whose handler declines to show a notification, so a muted
 * event has to be one the server never sends. localStorage stays the source of
 * truth; the server holds a per-device copy and does the filtering. See
 * lib/webPush.ts.
 */

/* ------------------------------------------------------------------ push */

/**
 * Server-sent Web Push. The only notification path that reaches a phone: iOS
 * suspends a backgrounded home-screen app, so the in-page toast below can never
 * fire there.
 */
function PushNotifications() {
  const state = useWebPush((s) => s.state);
  const busy = useWebPush((s) => s.busy);
  const error = useWebPush((s) => s.error);
  const notice = useWebPush((s) => s.notice);
  const enable = useWebPush((s) => s.enable);
  const disable = useWebPush((s) => s.disable);
  const test = useWebPush((s) => s.test);
  const hydrate = useWebPush((s) => s.hydrate);
  const unavailable = pushUnavailableReason();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="rounded-md border border-line bg-inset/40 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-secondary">Push notifications</span>
        {unavailable ? null : state === "subscribed" ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test()}>
              {busy ? "Sending…" : "Send test"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void disable()}>
              Turn off
            </Button>
          </div>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void enable()}>
            {busy ? "Enabling…" : "Enable"}
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs leading-snug text-faint">
        {unavailable ??
          (state === "subscribed"
            ? "This device is registered. Notifications arrive even when Dispatch is closed — including on iOS, where nothing else can reach you."
            : "Sent by the server, so they arrive with the app closed. On iPhone and iPad this is the only kind that works: iOS suspends a backgrounded web app, and a suspended app can't raise a toast.")}
      </p>
      {error ? <p className="mt-1 text-xs leading-snug text-warn">{error}</p> : null}
      {notice && !error ? (
        <p className="mt-1 text-xs leading-snug text-faint">{notice}</p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- filters */

const KIND_ROWS: Array<{ key: keyof NotificationPrefs["kinds"]; label: string; hint: string }> = [
  { key: "permission", label: "Permission needed", hint: "an agent is blocked on your approval" },
  { key: "question", label: "Question", hint: "an agent asked you something directly" },
  { key: "idle", label: "Waiting for input", hint: "a turn ended and nothing is running" },
  { key: "done", label: "Task done", hint: "a chat finished its work" },
  { key: "review", label: "PR review activity", hint: "checks, comments and reviews" },
];

const REVIEW_ROWS: Array<{
  key: keyof NotificationPrefs["reviewKinds"];
  label: string;
  hint: string;
}> = [
  { key: "check", label: "Check failed", hint: "CI went red" },
  { key: "comment", label: "Review comment", hint: "a new unresolved thread" },
  { key: "review", label: "Review submitted", hint: "approved / changes requested" },
  { key: "settled", label: "PR merged or closed", hint: "the PR reached its end state" },
];

/** A label + switch row, sized to sit in a dense list. */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="truncate text-sm text-secondary">{label}</div>
        <div className="truncate text-xs text-faint">{hint}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={checked ? "On" : "Off"} />
    </div>
  );
}

function NotificationFilters() {
  const prefs = useWebPush((s) => s.prefs);
  const setPrefs = useWebPush((s) => s.setPrefs);

  // Unset means ON. A kind added in a later version must not arrive muted on
  // every device that already has prefs stored — see `shouldNotify`.
  const kindOn = (k: keyof NotificationPrefs["kinds"]) => prefs.kinds[k] !== false;
  const reviewOn = (k: keyof NotificationPrefs["reviewKinds"]) => prefs.reviewKinds[k] !== false;

  const setKind = (k: keyof NotificationPrefs["kinds"], v: boolean) =>
    setPrefs({ ...prefs, kinds: { ...prefs.kinds, [k]: v } });
  const setReview = (k: keyof NotificationPrefs["reviewKinds"], v: boolean) =>
    setPrefs({ ...prefs, reviewKinds: { ...prefs.reviewKinds, [k]: v } });

  const quiet = prefs.quietHours ?? {
    enabled: false,
    start: "22:00",
    end: "07:00",
    tz: deviceTimeZone(),
  };
  const setQuiet = (p: Partial<typeof quiet>) =>
    // The zone is re-stamped on every edit rather than captured once: the server
    // evaluates the window, and a laptop that changed continents would otherwise
    // keep going quiet on the old one's clock.
    setPrefs({ ...prefs, quietHours: { ...quiet, ...p, tz: deviceTimeZone() } });

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <SectionLabel className="px-0">What to notify me about</SectionLabel>
          <Switch
            checked={prefs.enabled}
            onChange={(v) => setPrefs({ ...prefs, enabled: v })}
            label={prefs.enabled ? "On" : "All muted"}
          />
        </div>
        <div
          className={cn(
            "divide-y divide-line/60 rounded-md border border-line bg-inset/40 px-2.5 transition-opacity",
            !prefs.enabled && "pointer-events-none opacity-45",
          )}
        >
          {KIND_ROWS.map((r) => (
            <ToggleRow
              key={r.key}
              label={r.label}
              hint={r.hint}
              checked={kindOn(r.key)}
              onChange={(v) => setKind(r.key, v)}
            />
          ))}
        </div>
      </div>

      <div>
        <SectionLabel className="mb-1.5 px-0">PR review activity</SectionLabel>
        <div
          className={cn(
            "divide-y divide-line/60 rounded-md border border-line bg-inset/40 px-2.5 transition-opacity",
            (!prefs.enabled || !kindOn("review")) && "pointer-events-none opacity-45",
          )}
        >
          {REVIEW_ROWS.map((r) => (
            <ToggleRow
              key={r.key}
              label={r.label}
              hint={r.hint}
              checked={reviewOn(r.key)}
              onChange={(v) => setReview(r.key, v)}
            />
          ))}
        </div>
        <p className="mt-1 text-xs leading-snug text-faint">
          One poll can find several at once — a failed check alongside a new comment. Such a round
          still notifies if any of its reasons is on, so muting nits never swallows a red check.
        </p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <SectionLabel className="px-0">Quiet hours</SectionLabel>
          <Switch
            checked={quiet.enabled}
            onChange={(v) => setQuiet({ enabled: v })}
            label={quiet.enabled ? "On" : "Off"}
          />
        </div>
        <div
          className={cn(
            "flex items-end gap-3 transition-opacity",
            !quiet.enabled && "pointer-events-none opacity-45",
          )}
        >
          <Field label="From">
            <TextInput
              mono
              type="time"
              value={quiet.start}
              onChange={(e) => setQuiet({ start: e.target.value })}
            />
          </Field>
          <Field label="Until">
            <TextInput
              mono
              type="time"
              value={quiet.end}
              onChange={(e) => setQuiet({ end: e.target.value })}
            />
          </Field>
        </div>
        <p className="mt-1 text-xs leading-snug text-faint">
          Nothing fires in this window. Evaluated in {quiet.tz || deviceTimeZone()} — this device's
          time zone, so it follows you rather than the server.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- in-page toast */

function DesktopNotifications() {
  const enabled = useBrowserNotify((s) => s.enabled);
  const permission = useBrowserNotify((s) => s.permission);
  const setEnabled = useBrowserNotify((s) => s.setEnabled);
  const request = useBrowserNotify((s) => s.request);
  const unavailable = notifyUnavailableReason();

  return (
    <div className="rounded-md border border-line bg-inset/40 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-secondary">Desktop notifications</span>
        {unavailable || permission === "unsupported" ? null : permission === "granted" ? (
          <Switch checked={enabled} onChange={setEnabled} label={enabled ? "On" : "Muted"} />
        ) : permission === "denied" ? (
          <span className="text-xs text-warn">Blocked</span>
        ) : (
          <Button size="sm" onClick={() => void request()}>
            Enable
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs leading-snug text-faint">
        {unavailable ??
          (permission === "denied"
            ? "You blocked notifications for this origin — re-allow them in the browser's site settings, then reopen this page."
            : "Raised by the open page, so it needs Dispatch to still be running — only while the app isn't focused. Clicking one jumps to the chat.")}
      </p>
    </div>
  );
}

export function NotificationsSection({ draft, patch }: AppPaneProps) {
  const wh = draft.webhook ?? {};
  const patchWebhook = (p: Partial<typeof wh>) => patch({ webhook: { ...wh, ...p } });

  return (
    <div className="space-y-4">
      <PushNotifications />
      <DesktopNotifications />
      <NotificationFilters />

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <SectionLabel className="px-0">Webhook</SectionLabel>
          <Switch
            checked={!!wh.enabled}
            onChange={(v) => patchWebhook({ enabled: v })}
            label={wh.enabled ? "Enabled" : "Disabled"}
          />
        </div>
        <div
          className={cn(
            "space-y-3 transition-opacity",
            !wh.enabled && "pointer-events-none opacity-45",
          )}
        >
          <Field label="Provider">
            <SegmentedControl
              size="md"
              value={wh.kind ?? "ntfy"}
              onChange={(v) => patchWebhook({ kind: v })}
              segments={[
                { value: "ntfy", label: "ntfy" },
                { value: "pushover", label: "Pushover" },
              ]}
            />
          </Field>
          <Field label="Webhook URL" hint="where push events POST">
            <TextInput
              mono
              value={wh.url ?? ""}
              onChange={(e) => patchWebhook({ url: e.target.value })}
              placeholder="https://ntfy.sh/your-topic"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
