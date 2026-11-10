import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for secrets and their hashes.
 *
 * One copy on purpose: auth, integration tokens and the OAuth server each grew
 * their own, and a timing-safe compare is exactly the code that must not drift
 * between call sites. The length check short-circuits because
 * `timingSafeEqual` THROWS on unequal lengths; every caller compares
 * fixed-width digests, so the length leaks nothing it doesn't already know.
 */
export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
