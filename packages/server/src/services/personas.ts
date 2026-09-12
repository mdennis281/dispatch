import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTHORED_NAME_RE, type Persona } from "@dispatch/shared";
import { type AuthoredConfigService, assertName, readInstructionsDir } from "./authored-config.js";

/** Read broadest first, replacing by id so exactly one definition is injected. */
export async function listPersonas(authored: AuthoredConfigService, configDir?: string): Promise<Persona[]> {
  const byId = new Map<string, Persona>();
  const app = await authored.list("persona");
  for (const item of app) {
    if (!AUTHORED_NAME_RE.test(item.name)) continue;
    const instructions = await readFile(item.path, "utf8");
    byId.set(item.name, toPersona(item.name, item.scope, instructions));
  }
  if (configDir) {
    for (const file of await readInstructionsDir(join(configDir, "personas"))) {
      if (!AUTHORED_NAME_RE.test(file.name)) continue;
      byId.set(file.name, toPersona(file.name, "project", file.text));
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function toPersona(id: string, scope: Persona["scope"], instructions: string): Persona {
  const heading = instructions.match(/^# +(.+)$/m)?.[1]?.trim();
  const label = id.replace(/-/g, " ");
  return { id, scope, instructions, name: heading || label[0]!.toUpperCase() + label.slice(1) };
}

export async function resolvePersona(authored: AuthoredConfigService, id: string, configDir?: string): Promise<Persona> {
  assertName(id);
  const persona = (await listPersonas(authored, configDir)).find((p) => p.id === id);
  if (!persona) throw new Error(`Persona "${id}" is unavailable. Choose another persona or turn it off.`);
  return persona;
}
