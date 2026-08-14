#!/usr/bin/env node
/**
 * `dispatch` — the Dispatch project CLI.
 *
 * Runs from inside any managed repo and edits that repo's committable
 * `.dispatch/` config. Today it manages MCP servers; the command surface is
 * shaped so other config kinds (agents, modes, sub-apps) can slot in as sibling
 * top-level commands later.
 *
 * The manager server watches `.dispatch/` and reloads on change, so an edit
 * made here takes effect in already-open chats without a restart.
 */
import { CmError } from "./core/manifest.js";
import { runMcpCommand } from "./commands/mcp.js";
import { runAuthCommand } from "./commands/auth.js";

const HELP = `cm — Dispatch project CLI

Usage:
  dispatch mcp <command> [options]    Manage this project's MCP servers
  dispatch auth reset-owner --config-dir <dir> [--data-dir <dir>] --password-stdin --confirm-stopped
  cm help                       Show this help

Run \`dispatch mcp help\` for the MCP command surface.

Config lives in .dispatch/project.yaml at the repo root — committable,
reviewable, and re-read live by Dispatch whenever it changes.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write("cm 0.0.0\n");
    return 0;
  }

  try {
    switch (command) {
      case "mcp":
        await runMcpCommand(rest);
        return 0;
      case "auth":
        await runAuthCommand(rest);
        return 0;
      default:
        process.stderr.write(`cm: unknown command "${command}"\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    // Expected, user-facing problems get a clean one-liner; anything else is a
    // real bug and keeps its stack so it can be reported.
    if (err instanceof CmError) {
      process.stderr.write(`cm: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`cm: unexpected error\n${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
