import { clsx, type ClassValue } from "clsx";

/** `clsx` under a short name — the one class-merge helper used across the kit. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
