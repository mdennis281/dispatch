import { useEffect, useState } from "react";
import {
  COMPACT_FOCUS_MAX,
  DEFAULT_MAX_ACTIVE_SESSIONS,
  DEFAULT_IDLE_SESSION_MINUTES,
  listProviders,
} from "@dispatch/shared";
import { Field, TextArea, TextInput } from "../../sidebar/Modal.js";
import { Switch } from "../../ui/Switch.js";
import { positiveTokenLimit } from "../../../lib/harness.js";
import { api } from "../../../lib/api.js";
import { useProviderRegistered } from "../../../lib/providerAvailability.js";
import { compactTokens } from "../../../lib/format.js";
import { cn } from "../../../lib/cn.js";
import type { AppPaneProps } from "./types.js";

/** Digits only, and `undefined` for an empty box — a blank field means "the
 *  default", which is not the same answer as zero. */
function numberField(raw: string): number | undefined {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * One model's compact threshold as a slider over its context window. The far
 * right end IS "max" — it stores nothing, which is what lets the runtime compact
 * on its own when the window fills — so there's no separate clear control.
 */
function ThresholdSlider({
  id,
  label,
  window,
  value,
  onChange,
}: {
  id: string;
  label: string;
  window: number;
  value: number | undefined;
  onChange: (tokens: number | undefined) => void;
}) {
  // 1k steps on a 200k window, 5k on 1M: fine enough to land on a round number,
  // coarse enough that a drag doesn't write a save-worthy patch per pixel.
  const step = window >= 500_000 ? 5_000 : 1_000;
  // Below a tenth of the window a chat would compact every few turns and spend
  // more on summaries than on work.
  const min = Math.round(window / 10 / step) * step;
  // A stored value past the window (typed in the old box, or set before the
  // account lost 1M context) pins to the right end but reads true.
  const pos = value == null ? window : Math.min(Math.max(value, min), window);
  const pct = Math.round((pos / window) * 100);
  return (
    <label className="block space-y-1" title={id}>
      <span className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-secondary">{label}</span>
        <span className="cm-mono shrink-0 text-2xs text-faint">
          {value == null ? (
            `max · ${compactTokens(window)}`
          ) : (
            <>
              <span className="text-secondary">{compactTokens(value)}</span> · {pct}%
            </>
          )}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={window}
        step={step}
        value={pos}
        aria-label={`${label} compact threshold`}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(n >= window ? undefined : n);
        }}
        className="h-1 w-full accent-[var(--p-accent)]"
      />
    </label>
  );
}

/**
 * Each provider's per-model windows, as its runtime reports them. Claude's
 * answer is a cold probe of tens of seconds (a `setModel` + `getContextUsage`
 * per model) before the server caches it, so rows render as number boxes until
 * it lands rather than holding the whole pane on a spinner.
 */
function useContextWindows(): Partial<Record<string, Record<string, number>>> {
  const [windows, setWindows] = useState<Partial<Record<string, Record<string, number>>>>({});
  useEffect(() => {
    let live = true;
    for (const { id } of listProviders()) {
      api.models
        .contextWindows(id)
        .then((w) => live && setWindows((prev) => ({ ...prev, [id]: w })))
        .catch(() => {
          /* unknown windows just keep the number box */
        });
    }
    return () => {
      live = false;
    };
  }, []);
  return windows;
}

/** How many chats run at once, and what happens as their context windows fill. */
export function ContextSection({ draft, patch, serverDefaults, catalogs }: AppPaneProps) {
  const windows = useContextWindows();
  const claude = useProviderRegistered("claude");
  const ac = draft.autoCompact ?? {};
  const perModel = ac.perModel ?? {};
  const patchPerModel = (id: string, tokens: number | undefined) => {
    // Delete rather than store `undefined`: an absent key is what "compact at
    // this model's max" means on the server, and a `null`-ish value would fail
    // the positive-integer schema on save.
    const next = { ...perModel };
    if (tokens) next[id] = tokens;
    else delete next[id];
    patch({ autoCompact: { ...ac, perModel: next } });
  };
  // Every catalog row except the `default` alias (it resolves to one of the
  // others, and the broker matches on the resolved id), plus any id that only
  // survives in settings — a model the catalog no longer lists would otherwise
  // keep firing with no field left to clear it from.
  const listedIds = new Set(
    Object.values(catalogs)
      .flat()
      .map((m) => m?.value),
  );
  const orphans = Object.keys(perModel).filter((id) => !listedIds.has(id));
  const harness = draft.harness ?? {};
  const limits = harness.contextLimits ?? {};
  const enabled = ac.enabled ?? true;
  // What a blank box actually means on THIS server — `DISPATCH_MAX_ACTIVE_SESSIONS`
  // moves it, so printing the shared constant would misreport the cap in force on
  // any install that sets the env var. The constant is only the stand-in for the
  // moment before the answer lands (and if the request failed).
  const defaultCap = serverDefaults?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
  const defaultIdle = serverDefaults?.idleSessionMinutes ?? DEFAULT_IDLE_SESSION_MINUTES;

  const patchLimits = (p: Partial<typeof limits>) =>
    patch({ harness: { ...harness, contextLimits: { ...limits, ...p } } });

  return (
    <div className="space-y-3">
      <div className="space-y-2 border-b border-line-soft pb-3">
        <Field label="Max active chats" hint={`blank = ${defaultCap}`} className="max-w-[12rem]">
          <TextInput
            mono
            inputMode="numeric"
            value={draft.maxActiveSessions != null ? String(draft.maxActiveSessions) : ""}
            onChange={(e) => patch({ maxActiveSessions: numberField(e.target.value) })}
            placeholder={String(defaultCap)}
          />
        </Field>
        <p className="text-xs leading-snug text-faint">
          How many chats may be WORKING at once. A chat holds a slot while it's generating,
          running a tool or running a shell command — and gives it back while it's blocked
          on something else: waiting on CI, on a peer chat, on a sleep, or on you for a
          permission or a question. A chat driving subagents still counts, because they're
          working on its behalf. Past the cap a turn shows as Queued and starts as soon as a
          slot frees, oldest first. Raising this drains the queue immediately; lowering it
          never interrupts a chat that's already running, and a blocked chat resumes the
          moment it's unblocked even if that briefly puts you over.
        </p>
      </div>

      <div className="space-y-2 border-b border-line-soft pb-3">
        <Field
          label="Retire idle chats"
          hint={`minutes; blank = ${defaultIdle}, 0 = never`}
          className="max-w-[12rem]"
        >
          <TextInput
            mono
            inputMode="numeric"
            value={draft.idleSessionMinutes != null ? String(draft.idleSessionMinutes) : ""}
            onChange={(e) => patch({ idleSessionMinutes: numberField(e.target.value) })}
            placeholder={String(defaultIdle)}
          />
        </Field>
        <p className="text-xs leading-snug text-faint">
          A chat you stop talking to keeps its runtime process and every MCP server under
          it — around 1.3&nbsp;GB each, and nothing used to take it back. After this long
          idle, that tree is retired. Nothing is lost: the transcript stays, and the next
          message resumes the session with its context, so the only cost is that message
          starting a little slower. Background shells are never touched — a chat parked for
          you to test against a dev server it started still has the dev server.
        </p>
      </div>

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
            onChange={(e) => patchLimits({ perChatTokens: numberField(e.target.value) })}
            placeholder="e.g. 180000"
          />
        </Field>
        <Field label="Overall limit" hint="active chats combined">
          <TextInput
            mono
            inputMode="numeric"
            value={limits.overallTokens != null ? String(limits.overallTokens) : ""}
            onChange={(e) => patchLimits({ overallTokens: numberField(e.target.value) })}
            placeholder="e.g. 600000"
          />
        </Field>
      </div>

      <div className={cn("transition-opacity", !enabled && "pointer-events-none opacity-45")}>
        {/* This is Claude Code's `autoCompactWindow` — the window SIZE it
            compacts ~33k short of, 100k–1M — not a reserve. It used to be
            labelled one with a 20000 placeholder, a value the CLI drops.
            Shown only while the Claude provider is registered (#428): no
            other runtime reads it. A value already saved is kept either way. */}
        {claude && (
        <Field label="Claude compaction window" hint="tokens, 100k–1M; blank = from thresholds">
          <TextInput
            mono
            inputMode="numeric"
            value={ac.window != null ? String(ac.window) : ""}
            onChange={(e) =>
              patch({ autoCompact: { ...ac, window: numberField(e.target.value) } })
            }
            placeholder="e.g. 400000"
          />
        </Field>
        )}
      </div>

      <div
        className={cn(
          "space-y-2 border-t border-line-soft pt-3 transition-opacity",
          !enabled && "pointer-events-none opacity-45",
        )}
      >
        <span className="text-xs font-medium text-secondary">Compact threshold by model</span>
        <p className="text-xs leading-snug text-faint">
          Compact a chat on this model once its context passes this many tokens. All the
          way right is the model's own maximum — the runtime compacts when the window
          actually fills. A value here beats the per-chat limit above for that model, and applies
          to Claude and Codex alike.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {listProviders().map(({ id: kind, label }, index) => {
            const rows = [
              ...(catalogs[kind] ?? [])
                .filter((m) => m.value !== "default")
                .map((m) => ({ id: m.value, label: m.label, window: windows[kind]?.[m.value] })),
              // An orphan's provider is unknown, so so is its window — it gets
              // the number box, which is also the only way to clear it.
              ...(index === 0
                ? orphans.map((id) => ({ id, label: id, window: undefined }))
                : []),
            ];
            return (
              <div key={kind} className="rounded-md border border-line bg-inset/40 p-2.5">
                <div className="mb-2 text-xs font-medium text-secondary">{label}</div>
                {rows.length === 0 ? (
                  <p className="text-xs text-faint">No models listed yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {rows.map((m) =>
                      m.window ? (
                        <ThresholdSlider
                          key={m.id}
                          id={m.id}
                          label={m.label}
                          window={m.window}
                          value={perModel[m.id]}
                          onChange={(v) => patchPerModel(m.id, v)}
                        />
                      ) : (
                        <div key={m.id} className="flex items-center gap-2">
                          <span
                            className="min-w-0 flex-1 truncate text-xs text-secondary"
                            title={m.id}
                          >
                            {m.label}
                          </span>
                          {/* Fixed slot: the shared input is w-full and would
                              otherwise squeeze the label to nothing. */}
                          <div className="w-[7.5rem] shrink-0">
                            <TextInput
                              mono
                              inputMode="numeric"
                              value={perModel[m.id] != null ? String(perModel[m.id]) : ""}
                              onChange={(e) => patchPerModel(m.id, numberField(e.target.value))}
                              placeholder="max"
                            />
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2 border-t border-line-soft pt-3">
        <Field label="What every compaction should keep" hint="optional">
          <TextArea
            rows={3}
            maxLength={COMPACT_FOCUS_MAX}
            value={ac.instructions ?? ""}
            onChange={(e) => patch({ autoCompact: { ...ac, instructions: e.target.value } })}
            placeholder="e.g. The task and its acceptance criteria, decisions already made, the PR number and branch, file paths still being edited."
          />
        </Field>
        <p className="text-xs leading-snug text-faint">
          Standing instructions for the summary. Used whenever Dispatch compacts a chat
          without a more specific focus — the meter's Compact button, an agent's
          compact_context call, and the thresholds above — and handed to Claude Code as
          its "Compact Instructions" so its own auto-compaction reads them too. A focus
          typed on the button or passed by the agent replaces this for that one
          compaction.
        </p>
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
