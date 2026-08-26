import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readTheme(name: "dark" | "dim" | "light"): string {
  return readFileSync(fileURLToPath(new URL(`./${name}.css`, import.meta.url)), "utf8");
}

function tokenNames(css: string): string[] {
  return [...css.matchAll(/(--p-[a-z0-9-]+)\s*:/g)].map((match) => match[1]!).sort();
}

function hexToken(css: string, name: string): string {
  const match = css.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`Missing solid hex token ${name}`);
  return match[1]!;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe("theme palettes", () => {
  it("keeps every palette on the same complete token contract", () => {
    const dark = tokenNames(readTheme("dark"));
    expect(tokenNames(readTheme("dim"))).toEqual(dark);
    expect(tokenNames(readTheme("light"))).toEqual(dark);
  });

  it("keeps dim text and text-sized accents legible on its lightest surface", () => {
    const dim = readTheme("dim");
    const overlay = hexToken(dim, "--p-overlay");
    for (const token of [
      "--p-text-primary",
      "--p-text-secondary",
      "--p-text-muted",
      "--p-text-faint",
      "--p-accent",
      "--p-accent-2",
    ]) {
      expect(contrast(hexToken(dim, token), overlay), token).toBeGreaterThanOrEqual(4.5);
    }
  });
});
