import type { IntegrationTrust } from "@dispatch/shared";
import type { SelectOption } from "../components/ui/Select.js";

/**
 * The words for an integration's trust level, shared by the Tokens and
 * Connected apps blocks so one connector is never described two ways.
 *
 * Two lengths on purpose. The row's dropdown puts the hint on the SAME line as
 * the label in a fixed-width menu, and a full sentence there squeezed the label
 * to nothing — the menu showed two truncated explanations and no option names.
 * So the menu gets a few words, and the mint form (cards with room to wrap)
 * says what the AGENT will do differently, which is the whole effect: neither
 * level changes what the token may call.
 */
export const TRUST_OPTIONS: SelectOption<IntegrationTrust>[] = [
  { value: "external", label: "Outside party", hint: "not your consent" },
  { value: "owner", label: "Speaks for me", hint: "acts as you" },
];

export const TRUST_DETAIL: Record<IntegrationTrust, string> = {
  external: "Agents treat its messages as relayed from outside — nothing it asks carries your consent.",
  owner: "A bot that relays your instructions. Agents act on them as if you typed them, approvals included.",
};

/** Raising a live token is asked about; lowering one never is. */
export const TRUST_CONFIRM = (name: string): string =>
  `Let "${name}" speak for you? Agents will act on its messages as if you typed them — ` +
  "including approvals like merging. Anyone holding its token gets that authority.";
