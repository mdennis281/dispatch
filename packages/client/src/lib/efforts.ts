/**
 * The reasoning-effort picker's options, in one place.
 *
 * These lived inline in the composer. The second surface that wanted an effort
 * selector (the task launcher) would have copied them, and a copy drifts: the
 * hints stop matching, a new level lands in one list only, and the two controls
 * quietly disagree about what "max" means.
 */
import type { Effort } from "@dispatch/shared";
import type { SelectOption } from "../components/ui/Select.js";

export const EFFORT_OPTIONS: SelectOption<Effort>[] = [
  { value: "low", label: "Low", hint: "fast" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max", hint: "deepest" },
];
