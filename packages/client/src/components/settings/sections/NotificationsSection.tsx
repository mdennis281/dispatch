import { Field, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { SectionLabel } from "../../ui/Panel.js";
import { Switch } from "../../ui/Switch.js";
import { useBrowserNotify, notifyUnavailableReason } from "../../../lib/browserNotify.js";
import { cn } from "../../../lib/cn.js";
import type { AppPaneProps } from "./types.js";

/**
 * Desktop notifications — the only control in Settings that is NOT saved
 * server-side, and deliberately so. The browser permission it depends on is
 * granted per origin per browser, so "on" can only ever mean "on in this
 * browser"; persisting it centrally would promise every device something one
 * device granted. Everything here lives in localStorage (see lib/browserNotify).
 *
 * It also means this control is live: it takes effect on click and has nothing
 * to do with the save bar at the bottom of the page.
 */
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
            : "An OS toast when an agent needs a decision, a question answered, or finishes — only while the app isn't focused. Clicking one jumps to the chat.")}
      </p>
    </div>
  );
}

export function NotificationsSection({ draft, patch }: AppPaneProps) {
  const wh = draft.webhook ?? {};
  const patchWebhook = (p: Partial<typeof wh>) => patch({ webhook: { ...wh, ...p } });

  return (
    <div className="space-y-4">
      <DesktopNotifications />

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
