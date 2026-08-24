/**
 * First-run setup state — whether this install has been through the wizard.
 *
 * The whole job here is telling a NEW install apart from an UPGRADED one, once,
 * and writing the answer down. Both look identical from any single request:
 * neither has a `setup` key in config.json, because neither existed when that
 * file was last written.
 *
 * `Store.isFreshInstall()` can tell them apart, but only during the first boot —
 * it is a snapshot taken before seeding, and the very act of seeding makes the
 * data root non-empty. Reading it per request would therefore show the wizard
 * once and then never again, which is the wrong failure: someone who restarts
 * the server halfway through setup has an install with no project and no route
 * back to the screen that creates one. So this resolves it at boot and persists
 * a concrete answer that later boots simply read.
 */
import type { Store } from "../store/index.js";
import type { SetupStatus } from "@dispatch/shared";

/**
 * Resolve `settings.setup` if it has never been resolved. Idempotent: once the
 * key exists this returns it untouched, so an upgrade to a newer build can
 * never re-open the wizard on a working install.
 */
export async function ensureSetupState(store: Store): Promise<SetupStatus> {
  const settings = await store.getSettings();
  if (settings.setup) {
    return { completed: settings.setup.completed, ...(settings.setup.completedAt ? { completedAt: settings.setup.completedAt } : {}) };
  }
  // An existing installation has already got itself into a working state by
  // whatever means it used before the wizard existed. Marking it complete is
  // not a guess about its config — it is a refusal to interrupt it.
  const completed = !store.isFreshInstall();
  const setup = completed ? { completed: true, completedAt: Date.now() } : { completed: false };
  await store.saveSettings({ ...settings, setup });
  return setup;
}

/** Read the resolved state. Falls back to "pending" only on a never-resolved store. */
export async function readSetupState(store: Store): Promise<SetupStatus> {
  const { setup } = await store.getSettings();
  if (!setup) return { completed: false };
  return { completed: setup.completed, ...(setup.completedAt ? { completedAt: setup.completedAt } : {}) };
}

/** Mark the wizard finished. Idempotent — re-finishing keeps the first timestamp. */
export async function completeSetup(store: Store): Promise<SetupStatus> {
  const settings = await store.getSettings();
  if (settings.setup?.completed) {
    return { completed: true, ...(settings.setup.completedAt ? { completedAt: settings.setup.completedAt } : {}) };
  }
  const setup = { completed: true, completedAt: Date.now() };
  await store.saveSettings({ ...settings, setup });
  return setup;
}
