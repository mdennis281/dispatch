import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthoredConfigService } from "./authored-config.js";
import { listPersonas, resolvePersona } from "./personas.js";

let root: string;
let authored: AuthoredConfigService;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dispatch-personas-"));
  authored = new AuthoredConfigService({ globalRoot: join(root, "global") });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("ships only Product owner and never includes it in always-on instructions", async () => {
  const items = await listPersonas(authored);
  expect(items.map((p) => p.id)).toEqual(["product-owner"]);
  expect(items[0]).toMatchObject({ name: "Product owner", scope: "shipped" });
  expect(items[0]!.instructions).toContain("chat_state");
  expect(items[0]!.instructions).toContain("context usage");
  expect(await authored.buildInjection()).not.toContain("principal-level product owner");
});

it("resolves exactly one definition, project over global over shipped", async () => {
  await authored.write("persona", "product-owner", "# My product owner\nGlobal.");
  expect(await resolvePersona(authored, "product-owner")).toMatchObject({ scope: "global", name: "My product owner" });
  const configDir = join(root, "external-project-config");
  await mkdir(join(configDir, "personas"), { recursive: true });
  await writeFile(join(configDir, "personas", "product-owner.md"), "# Project owner\nProject.");
  const items = await listPersonas(authored, configDir);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ scope: "project", name: "Project owner", instructions: "# Project owner\nProject." });
  await expect(resolvePersona(authored, "missing", configDir)).rejects.toThrow("unavailable");
  await expect(resolvePersona(authored, "../escape", configDir)).rejects.toThrow("not a valid name");
});
