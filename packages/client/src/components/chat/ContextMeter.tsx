import { useEffect, useState } from "react";
import { Layers, Eraser, Loader2, AlertTriangle } from "lucide-react";
import type { ContextUsage } from "@dispatch/shared";
import { useContextTokens, useContextWindow } from "../../stores/messages.js";
import { compactTokens } from "../../lib/format.js";
import { Tooltip } from "../ui/Tooltip.js";
import { Popover } from "../ui/Popover.js";
import { api } from "../../lib/api.js";
import { actions } from "../../lib/actions.js";
import { cn } from "../../lib/cn.js";

/**
 * Fallback context windows by model id, used ONLY until a turn reports the SDK's
 * authoritative window (`result.contextWindow`). Keyed by the composer's model
 * ids; the `[1m]` variant is the 1M-context Opus. Anything unknown assumes 200k.
 */
const MODEL_WINDOW_FALLBACK: Record<string, number> = {
  "claude-opus-4-8": 200_000,
  "claude-opus-4-8[1m]": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};
const DEFAULT_WINDOW = 200_000;

/** Escalating tone by utilization — mirrors the header UsageMeter thresholds. */
function tone(pct: number): { text: string; bar: string } {
  if (pct >= 90) return { text: "text-danger", bar: "bg-danger" };
  if (pct >= 70) return { text: "text-warn", bar: "bg-warn" };
  return { text: "text-secondary", bar: "bg-accent" };
}

const clampPct = (p: number) => Math.max(0, Math.min(100, p));

export interface ContextMeterProps {
  chatId: string;
  /** The chat's active model — picks the fallback window before a turn reports one. */
  model?: string;
  /** Compact composer mode: bar only, token count lives in the tooltip. */
  iconOnly?: boolean;
}

/**
 * A compact context-window gauge for the composer toolbar: a mini fill bar plus
 * the running token count, tone-escalating as the window fills. The denominator
 * is the session's real window (the SDK's `maxTokens`, stamped on each result
 * row — 1M for the Opus 1M variant, not a hardcoded 200k), falling back to a
 * per-model default until the first turn reports it. Clicking opens a dropup with
 * the live category breakdown and compact/clear actions.
 */
export function ContextMeter({ chatId, model, iconOnly = false }: ContextMeterProps) {
  const { tokens, window, pct } = useContextUsage(chatId, model);
  const t = tone(pct);

  const tip =
    tokens === null
      ? "Context window — no usage reported yet · click to manage"
      : `Context · ${compactTokens(tokens)} / ${compactTokens(window)} (${Math.round(pct)}%) · click to manage`;

  return (
    <Popover
      side="top"
      align="end"
      width={280}
      className="p-0"
      trigger={({ open, toggle }) => {
        const btn = (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label="Context window"
            className={cn(
              "inline-flex select-none items-center gap-1.5 rounded-md px-1 py-0.5 " +
                "transition-colors hover:bg-active",
              open && "bg-active",
            )}
          >
            <span className="relative h-1 w-7 overflow-hidden rounded-full bg-line">
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full transition-[width]",
                  t.bar,
                )}
                style={{ width: `${clampPct(pct)}%` }}
              />
            </span>
            {!iconOnly && (
              <span
                className={cn(
                  "cm-mono text-2xs font-medium tabular-nums",
                  tokens === null ? "text-faint" : t.text,
                )}
              >
                {tokens === null ? "—" : compactTokens(tokens)}
              </span>
            )}
          </button>
        );
        return <Tooltip label={tip}>{btn}</Tooltip>;
      }}
    >
      {(close) => (
        <ContextPanel
          chatId={chatId}
          fallbackTokens={tokens}
          fallbackWindow={window}
          close={close}
        />
      )}
    </Popover>
  );
}

/** The meter's numbers: what a turn reported, over the session's real window. */
function useContextUsage(chatId: string, model?: string) {
  const tokens = useContextTokens(chatId);
  const reportedWindow = useContextWindow(chatId);
  const window =
    reportedWindow ?? (model ? MODEL_WINDOW_FALLBACK[model] : undefined) ?? DEFAULT_WINDOW;
  return { tokens, window, pct: tokens === null ? 0 : (tokens / window) * 100 };
}

/**
 * The same numbers as a menu-row hint. A component rather than a value the
 * composer computes, so the token subscription stays down here — the composer
 * hosts a TipTap editor and does not need to re-render on every usage update
 * just to label one row of a sheet.
 */
export function ContextHint({ chatId, model }: { chatId: string; model?: string }) {
  const { tokens, window } = useContextUsage(chatId, model);
  return <>{tokens === null ? "—" : `${compactTokens(tokens)} / ${compactTokens(window)}`}</>;
}

/**
 * The dropup body on its own, for the composer's phone-width overflow sheet,
 * which drills into it IN PLACE. It can't open the meter's own popover instead:
 * that popover would be nested inside the sheet, and a nested `Popover` portals
 * out of its parent's outside-click test, closing the parent on the first tap
 * (see ui/Popover).
 */
export function ContextPanelBody({
  chatId,
  model,
  close,
}: {
  chatId: string;
  model?: string;
  close: () => void;
}) {
  const { tokens, window } = useContextUsage(chatId, model);
  return (
    <ContextPanel chatId={chatId} fallbackTokens={tokens} fallbackWindow={window} close={close} />
  );
}

/* ---------------------------------------------------------------- dropup panel */

interface ContextPanelProps {
  chatId: string;
  /** Meter's own numbers, shown until (and if) the live breakdown loads. */
  fallbackTokens: number | null;
  fallbackWindow: number;
  close: () => void;
}

/**
 * The dropup body: fetches the live context breakdown on mount (only mounted when
 * the popover is open), shows tokens-by-category, and offers compact/clear. The
 * fetch is authoritative; if it's unavailable (subprocess not live), the meter's
 * stamped numbers still headline the panel.
 */
function ContextPanel({ chatId, fallbackTokens, fallbackWindow, close }: ContextPanelProps) {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.chats
      .contextUsage(chatId)
      .then((r) => alive && setUsage(r.usage))
      .catch(() => alive && setUsage(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [chatId]);

  const total = usage?.totalTokens ?? fallbackTokens ?? 0;
  const max = usage?.maxTokens ?? fallbackWindow;
  const pct = max > 0 ? clampPct((total / max) * 100) : 0;
  const t = tone(pct);

  const cats = (usage?.categories ?? [])
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const doCompact = () => {
    actions.compactContext(chatId);
    close();
  };
  const doClear = () => {
    actions.clearContext(chatId);
    close();
  };

  return (
    <div className="flex w-full flex-col">
      {/* headline */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">
            Context window
          </span>
          <span className={cn("cm-mono text-xs tabular-nums", t.text)}>
            {Math.round(pct)}%
          </span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-1">
          <span className={cn("cm-mono text-xl font-semibold tabular-nums", t.text)}>
            {compactTokens(total)}
          </span>
          <span className="cm-mono text-xs tabular-nums text-faint">
            / {compactTokens(max)}
          </span>
          {usage?.model && (
            <span className="ml-auto truncate text-2xs text-faint">{usage.model}</span>
          )}
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
          <span
            className={cn("block h-full rounded-full transition-[width]", t.bar)}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* breakdown */}
      <div className="border-t border-line-soft px-3 py-2">
        {loading ? (
          <div className="flex items-center gap-2 py-1 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" />
            Reading context…
          </div>
        ) : cats.length > 0 ? (
          <div className="flex flex-col gap-1">
            {cats.map((c) => (
              <div key={c.name} className="flex items-center gap-2 text-xs">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: c.color || "var(--p-text-faint)" }}
                />
                <span className="flex-1 truncate text-secondary">{c.name}</span>
                <span className="cm-mono shrink-0 tabular-nums text-muted">
                  {compactTokens(c.tokens)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-1 text-xs text-faint">
            Live breakdown unavailable — run a turn, then reopen.
          </div>
        )}
      </div>

      {/* actions */}
      <div className="flex flex-col gap-1 border-t border-line-soft p-1.5">
        <button
          type="button"
          onClick={doCompact}
          className="flex items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-active"
        >
          <Layers className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <span className="leading-tight">
            <span className="block text-sm text-secondary">Compact context</span>
            <span className="block text-2xs text-faint">
              Summarize the conversation, keep going smaller
            </span>
          </span>
        </button>

        {confirmClear ? (
          <div className="flex items-center gap-1 px-2 py-1">
            <AlertTriangle className="size-3.5 shrink-0 text-warn" />
            <span className="flex-1 text-xs text-secondary">Clear the model's context?</span>
            <button
              type="button"
              onClick={doClear}
              className="rounded-sm bg-danger/15 px-1.5 py-0.5 text-xs font-medium text-danger hover:bg-danger/25"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="rounded-sm px-1.5 py-0.5 text-xs text-muted hover:text-secondary"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            className="flex items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-active"
          >
            <Eraser className="mt-0.5 size-3.5 shrink-0 text-muted" />
            <span className="leading-tight">
              <span className="block text-sm text-secondary">Clear context</span>
              <span className="block text-2xs text-faint">
                Reset the model's window; transcript is kept
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
