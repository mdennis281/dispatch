/**
 * The one way the host renders plugin UI: a component boundary plus an error
 * boundary, scoped to the plugin.
 *
 * Why not call `def.render(...)` inline where the slot sits — which is what
 * the first cut did? Two failures, both found on review:
 *
 *   1. A `render` that throws (`chat.ext.voice.mode` with no `ext`) would
 *      propagate out of the HOST component and take the whole region down —
 *      the composer on every chat, for a composer control. `loader.ts`
 *      isolates `activate()`; nothing isolated a render.
 *   2. A `render` that calls a hook — natural, the host hands out
 *      `host.React` — would run that hook inside the host component, whose
 *      hook count then changes whenever the slot list does: "Rendered more
 *      hooks than during the previous render", and the host crashes.
 *
 * `SlotBody` makes `render` a component of its own, so a hook in it belongs
 * to the slot, and `SlotErrorBoundary` turns a throw into an inline "<plugin>
 * failed · Retry" in the slot's place. Every slot call site goes through this.
 */
import type { ReactNode } from "react";
import { SlotErrorBoundary } from "../components/ErrorBoundary.js";

interface SlotBodyProps<A extends unknown[]> {
  render: (...args: A) => ReactNode;
  args: [...A];
}

function SlotBody<A extends unknown[]>({ render, args }: SlotBodyProps<A>) {
  return <>{render(...args)}</>;
}

export interface PluginSlotProps<A extends unknown[]> extends SlotBodyProps<A> {
  pluginId: string;
  /** Which slot, for the fallback text and the error report: "chatBadge", "panelTab log"… */
  slot: string;
  /** Re-arm the boundary when this changes (a different chat, say) — see `Boundary.resetKey`. */
  resetKey?: string;
}

export function PluginSlot<A extends unknown[]>({ pluginId, slot, resetKey, render, args }: PluginSlotProps<A>) {
  return (
    <SlotErrorBoundary pluginId={pluginId} slot={slot} resetKey={resetKey}>
      <SlotBody render={render} args={args} />
    </SlotErrorBoundary>
  );
}
