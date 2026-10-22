/**
 * The scope chips a token row, a grant row and the consent page share.
 *
 * ONE renderer, because the three used to be three copies of the same map and
 * all three showed `tools:session`-style scopes — valid to parse, but over a
 * category with no external tool, so the mount answers 404 for them — as if
 * they granted something. A scope that grants nothing is not shown: the row is
 * a statement of what the holder can do, and that scope is not part of it.
 * Validation stays wider on purpose (see OFFERABLE_INTEGRATION_SCOPES in
 * @dispatch/shared), so a token minted with one before the offer narrowed
 * still loads; it just no longer advertises a power it never had.
 */
import { isOfferableIntegrationScope, type IntegrationScope } from "@dispatch/shared";
import { Chip } from "./Chip.js";

/** The scopes worth rendering, in the order given. Pure, so it is testable without the DOM. */
export function renderableScopes(scopes: readonly string[]): IntegrationScope[] {
  return scopes.filter(isOfferableIntegrationScope);
}

export function ScopeChips({ scopes, className }: { scopes: readonly string[]; className?: string }) {
  return (
    <span className={className ?? "flex flex-wrap gap-1"}>
      {renderableScopes(scopes).map((s) => (
        <Chip key={s} tone={s.startsWith("tools:") ? "agent" : "info"} className="!text-2xs">
          {s}
        </Chip>
      ))}
    </span>
  );
}
