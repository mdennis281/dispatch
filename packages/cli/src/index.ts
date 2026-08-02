#!/usr/bin/env node
/**
 * `cm` — the claude-manager project CLI.
 *
 * Runs from inside any managed repo and edits that repo's committable
 * `.claude-manager/` config. Today it manages MCP servers; the command surface is
 * shaped so other config kinds (agents, modes, sub-apps) can slot in as sibling
 * top-level commands later.
 *
 * The manager server watches `.claude-manager/` and reloads on change, so an edit
 * made here takes effect in already-open chats without a restart.
 */
import { CmError } from "./core/manifest.js";
import { runMcpCommand } from "./commands/mcp.js";

const HELP = `cm — claude-manager project CLI

Usage:
  cm mcp <command> [options]    Manage this project's MCP servers
  cm help                       Show this help

Run \`cm mcp help\` for the MCP command surface.

Config lives in .claude-manager/project.yaml at the repo root — committable,
reviewable, and re-read live by claude-manager whenever it changes.
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
