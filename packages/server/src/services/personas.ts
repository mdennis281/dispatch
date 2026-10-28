import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTHORED_NAME_RE, type Persona } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import { type AuthoredConfigService, assertName, readInstructionsDir } from "./authored-config.js";
import { configPathsFor } from "./config-location.js";

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

/**
 * The personas a chat in `projectId` can run as — the project's own included,
 * resolved through the same config dir `createChat` resolves a `personaId`
 * against, so what a list offers is exactly what a spawn will accept. No
 * project (or an unknown one): the shared set only.
 */
export async function personasFor(
  store: Pick<Store, "getProject" | "projectConfigDir">,
  authored: AuthoredConfigService,
  projectId?: string,
): Promise<Persona[]> {
  const project = projectId ? await store.getProject(projectId).catch(() => null) : null;
  const paths = project ? configPathsFor(project, store.projectConfigDir(project.id)) : null;
  return listPersonas(authored, paths?.configDir);
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
