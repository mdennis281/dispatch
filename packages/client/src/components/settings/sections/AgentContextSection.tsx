/**
 * Agent context — what every agent is handed before it reads the task.
 *
 * Split from the existing "Context" section deliberately, even though the names
 * sit next to each other in the rail. That one is about the machine (how many
 * chats run at once, when a window compacts); this one is about the PROMPT. They
 * were never the same question and merging them would have buried the house
 * rules under a token-limit form.
 *
 * Everything here is priced in the UI because everything here is paid on every
 * turn forever. A blank field is always "the default", never zero — see
 * `numberField`.
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_HOUSE_RULES_LIMIT,
  DEFAULT_MEMORY_CHAR_BUDGET,
  DEFAULT_MEMORY_FULL_LIMIT,
  DEFAULT_MEMORY_SURFACE_LIMIT,
  HOUSE_RULES_LIMIT_CEILING,
  MEMORY_CHAR_BUDGET_CEILING,
  MEMORY_FULL_LIMIT_CEILING,
  MEMORY_SURFACE_LIMIT_CEILING,
  type HouseRules,
} from "@dispatch/shared";
import { api, ApiError } from "../../../lib/api.js";
import { Field, TextInput } from "../../sidebar/Modal.js";
import { HouseRulesEditor } from "../HouseRulesEditor.js";
import type { AppPaneProps } from "./types.js";

/** Digits only; `undefined` for an empty box — blank means "the default". */
function numberField(raw: string): number | undefined {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** ~4 chars per token is close enough to make a budget legible as a cost. */
function approxTokens(chars: number): string {
  return `≈${Math.round(chars / 4).toLocaleString()} tokens`;
}

export function AgentContextSection({ draft, patch }: AppPaneProps) {
  const ctx = draft.agentContext ?? {};
  const mem = ctx.memory ?? {};
  const patchMemory = (p: Partial<typeof mem>) =>
    patch({ agentContext: { ...ctx, memory: { ...mem, ...p } } });

  // The global house-rules file, fetched here rather than threaded through the
  // settings draft: it is a FILE with its own endpoint and its own cap error,
  // not a field of config.json, and folding it into the draft would make a
  // routine theme save able to rewrite it.
  const [rules, setRules] = useState<HouseRules | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.houseRules
      .get()
      .then((r) => live && setRules(r))
      .catch(
        (err) => live && setLoadError(err instanceof ApiError ? err.message : "Failed to load."),
      );
    return () => {
      live = false;
    };
  }, []);

  const limit = ctx.houseRulesLimit ?? DEFAULT_HOUSE_RULES_LIMIT;

  return (
    <div className="space-y-3">
      <div className="space-y-2 border-b border-line-soft pb-4">
        <div className="text-xs font-medium text-secondary">House rules</div>
        <p className="text-xs leading-snug text-faint">
          The one block injected into every chat unconditionally, ahead of every instruction
          layer. Everything else Dispatch attaches is conditional — memory surfaces when it
          matches, a skill loads when it's relevant — so this is the only place a rule is
          guaranteed to arrive. Keep it to things an agent gets wrong without it.
        </p>
        {loadError ? (
          <p className="text-xs text-danger">{loadError}</p>
        ) : rules ? (
          <HouseRulesEditor
            file={rules.global}
            onSaved={(saved) => setRules((r) => (r ? { ...r, global: saved } : r))}
          />
        ) : (
          <p className="text-xs text-faint">Loading…</p>
        )}
      </div>

      <div className="space-y-2 border-b border-line-soft pb-4">
        <Field
          label="House-rules cap"
          hint={`chars per file; blank = ${DEFAULT_HOUSE_RULES_LIMIT}`}
          className="max-w-[12rem]"
        >
          <TextInput
            mono
            inputMode="numeric"
            value={ctx.houseRulesLimit != null ? String(ctx.houseRulesLimit) : ""}
            onChange={(e) => patch({ agentContext: { ...ctx, houseRulesLimit: numberField(e.target.value) } })}
            placeholder={String(DEFAULT_HOUSE_RULES_LIMIT)}
          />
        </Field>
        <p className="text-xs leading-snug text-faint">
          Applies to each of the two files separately, so both at the cap is twice this —{" "}
          {approxTokens(limit * 2)} spent before the conversation starts. A write over the cap
          is refused rather than truncated, and a file hand-edited past it is clipped at
          injection. Hard ceiling {HOUSE_RULES_LIMIT_CEILING.toLocaleString()}: past that you
          don't want house rules, you want a skill that loads when it's relevant.
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-secondary">Memory surfaced per turn</div>
        <p className="text-xs leading-snug text-faint">
          Durable project facts are ranked against each message. A confident match arrives as a
          full body; a plausible one arrives as a name and one line the agent can pull with{" "}
          <code className="cm-mono !text-2xs">recall</code>. These bound both tiers.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Memories per turn" hint={`blank = ${DEFAULT_MEMORY_SURFACE_LIMIT}`}>
            <TextInput
              mono
              inputMode="numeric"
              value={mem.surfaceLimit != null ? String(mem.surfaceLimit) : ""}
              onChange={(e) => patchMemory({ surfaceLimit: numberField(e.target.value) })}
              placeholder={String(DEFAULT_MEMORY_SURFACE_LIMIT)}
            />
          </Field>
          <Field label="Of those, in full" hint={`blank = ${DEFAULT_MEMORY_FULL_LIMIT}`}>
            <TextInput
              mono
              inputMode="numeric"
              value={mem.fullLimit != null ? String(mem.fullLimit) : ""}
              onChange={(e) => patchMemory({ fullLimit: numberField(e.target.value) })}
              placeholder={String(DEFAULT_MEMORY_FULL_LIMIT)}
            />
          </Field>
        </div>
        <Field
          label="Char budget"
          hint={`blank = ${DEFAULT_MEMORY_CHAR_BUDGET}`}
          className="max-w-[12rem]"
        >
          <TextInput
            mono
            inputMode="numeric"
            value={mem.charBudget != null ? String(mem.charBudget) : ""}
            onChange={(e) => patchMemory({ charBudget: numberField(e.target.value) })}
            placeholder={String(DEFAULT_MEMORY_CHAR_BUDGET)}
          />
        </Field>
        <p className="text-xs leading-snug text-faint">
          The budget is the real limit — bodies are clipped to fit it, and one that would be
          clipped too far is demoted to a pointer instead. Raising the counts without raising
          it just buys more one-liners. Ceilings:{" "}
          {MEMORY_SURFACE_LIMIT_CEILING}/{MEMORY_FULL_LIMIT_CEILING}/
          {MEMORY_CHAR_BUDGET_CEILING.toLocaleString()}.
        </p>
        <p className="text-xs leading-snug text-faint">
          Defaults were calibrated against a 141-memory store: a squarely on-topic turn scores
          its best match far above the noise, so a bigger budget mostly buys near-misses. Worth
          raising on a project with hundreds of memories, or where facts are unusually long.
        </p>
      </div>
    </div>
  );
}
