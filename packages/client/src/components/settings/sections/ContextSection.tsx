import { Field, TextInput } from "../../sidebar/Modal.js";
import { Switch } from "../../ui/Switch.js";
import { positiveTokenLimit } from "../../../lib/harness.js";
import { cn } from "../../../lib/cn.js";
import type { AppPaneProps } from "./types.js";

/** Digits only, and `undefined` for an empty box — a blank field means "no
 *  limit", which is not the same answer as zero. */
function tokenField(raw: string): number | undefined {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** What happens as the context window fills. */
export function ContextSection({ draft, patch }: AppPaneProps) {
  const ac = draft.autoCompact ?? {};
  const harness = draft.harness ?? {};
  const limits = harness.contextLimits ?? {};
  const enabled = ac.enabled ?? true;

  const patchLimits = (p: Partial<typeof limits>) =>
    patch({ harness: { ...harness, contextLimits: { ...limits, ...p } } });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-secondary">Auto-compaction</span>
        <Switch
          checked={enabled}
          onChange={(v) => patch({ autoCompact: { ...ac, enabled: v } })}
          label={enabled ? "On" : "Off"}
        />
      </div>
      <p className="text-xs leading-snug text-faint">
        When a session's context window fills, summarize the conversation and continue
        automatically instead of erroring. Applies to new turns.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Per-chat limit" hint="tokens; blank = model limit">
          <TextInput
            mono
            inputMode="numeric"
            value={limits.perChatTokens != null ? String(limits.perChatTokens) : ""}
            onChange={(e) => patchLimits({ perChatTokens: tokenField(e.target.value) })}
            placeholder="e.g. 180000"
          />
        </Field>
        <Field label="Overall limit" hint="active chats combined">
          <TextInput
            mono
            inputMode="numeric"
            value={limits.overallTokens != null ? String(limits.overallTokens) : ""}
            onChange={(e) => patchLimits({ overallTokens: tokenField(e.target.value) })}
            placeholder="e.g. 600000"
          />
        </Field>
      </div>

      <div className={cn("transition-opacity", !enabled && "pointer-events-none opacity-45")}>
        <Field label="Reserve window" hint="tokens; blank = SDK default">
          <TextInput
            mono
            inputMode="numeric"
            value={ac.window != null ? String(ac.window) : ""}
            onChange={(e) =>
              patch({ autoCompact: { ...ac, window: tokenField(e.target.value) } })
            }
            placeholder="e.g. 20000"
          />
        </Field>
      </div>
    </div>
  );
}

/** Normalize the limits the same way the old modal's `save()` did — kept beside
 *  the fields that produce them so the two can't drift. */
export function normalizeContextLimits(limits: {
  perChatTokens?: number;
  overallTokens?: number;
}): { perChatTokens?: number; overallTokens?: number } {
  return {
    perChatTokens: positiveTokenLimit(limits.perChatTokens),
    overallTokens: positiveTokenLimit(limits.overallTokens),
  };
}
