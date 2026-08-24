/**
 * REST for the first-run setup wizard.
 *   GET  /api/setup          → SetupStatus (is the wizard still owed?)
 *   GET  /api/setup/github   → GhCliStatus, probed LIVE
 *   POST /api/setup/complete → mark the wizard finished
 *
 * The github probe is deliberately uncached. Its entire purpose is the Re-check
 * button: you read "gh is not installed", you install it in another window, and
 * you press the button. A cached answer would tell you it still isn't — which is
 * worse than not checking, because it looks authoritative.
 *
 * `POST /complete` takes no body and asserts nothing about what the wizard did.
 * The steps it covers are checks and a project, and both of those are already
 * recorded where they belong (the probe reads the machine; the project is a real
 * project). A "completed" that carried its own copy of that state would be a
 * second source of truth that could disagree with the first.
 */
import type { FastifyInstance } from "fastify";
import { completeSetup, readSetupState } from "../services/setup.js";

export function registerSetupRoutes(app: FastifyInstance): void {
  const { store } = app.cm;

  app.get("/api/setup", async () => readSetupState(store));

  app.get("/api/setup/github", async () => app.services.github.cliStatus());

  app.post("/api/setup/complete", async () => completeSetup(store));
}
