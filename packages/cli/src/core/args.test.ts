/**
 * Arg-parsing tests. The contract these lock down is COMPATIBILITY: a command
 * line copied straight out of an MCP server's README (which will be written for
 * `claude mcp add`) has to produce the right transport here too.
 */
import { describe, it, expect } from "vitest";
import { parseArgs, transportFromArgs, parseEnvPairs, parseHeaderPairs, all, flag } from "./args.js";
import { CmError } from "./manifest.js";

/** Parse `dispatch mcp add` argv (everything after the subcommand). */
function addArgs(line: string) {
  const argv = line.split(" ").filter(Boolean);
  const parsed = parseArgs(argv);
  const [, ...rest] = parsed.positionals;
  return { parsed, rest };
}

describe("parseArgs", () => {
  it("separates positionals, flags, and post-`--` argv", () => {
    const p = parseArgs(["ripgrep", "-e", "A=1", "--", "npx", "-y", "pkg"]);
    expect(p.positionals).toEqual(["ripgrep"]);
    expect(all(p, "env")).toEqual(["A=1"]);
    expect(p.rest).toEqual(["npx", "-y", "pkg"]);
  });

  it("does not interpret flags that appear after `--`", () => {
    const p = parseArgs(["name", "--", "npx", "--transport", "weird"]);
    expect(flag(p, "transport")).toBeUndefined();
    expect(p.rest).toEqual(["npx", "--transport", "weird"]);
  });

  it("accepts --flag=value and repeated flags", () => {
    const p = parseArgs(["--transport=http", "-H", "A: 1", "-H", "B: 2"]);
    expect(flag(p, "transport")).toBe("http");
    expect(all(p, "header")).toEqual(["A: 1", "B: 2"]);
  });

  it("errors on a value flag with nothing after it", () => {
    expect(() => parseArgs(["--url"])).toThrow(CmError);
  });

  it("errors on an unknown short flag", () => {
    expect(() => parseArgs(["-Z"])).toThrow(/Unknown flag/);
  });
});

describe("transportFromArgs", () => {
  it("builds a stdio transport from post-`--` argv", () => {
    const { parsed, rest } = addArgs("ripgrep -- npx -y mcp-ripgrep@latest");
    expect(transportFromArgs(parsed, rest)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "mcp-ripgrep@latest"],
    });
  });

  it("collects repeated --env into the stdio env map", () => {
    const { parsed, rest } = addArgs("pg -e A=1 -e B=two -- npx server");
    expect(transportFromArgs(parsed, rest)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["server"],
      env: { A: "1", B: "two" },
    });
  });

  it("infers http when only --url is given", () => {
    const { parsed, rest } = addArgs("linear --url https://mcp.linear.app/mcp");
    expect(transportFromArgs(parsed, rest)).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
    });
  });

  it("honours an explicit --transport sse", () => {
    const { parsed, rest } = addArgs("sentry --transport sse --url https://mcp.sentry.dev/sse");
    expect(transportFromArgs(parsed, rest)).toMatchObject({ type: "sse" });
  });

  it("supports --command with plain positional args", () => {
    const { parsed, rest } = addArgs("rg --command uvx mcp-server-git");
    expect(transportFromArgs(parsed, rest)).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["mcp-server-git"],
    });
  });

  it("keeps the parser strict: a flag-like arg needs the `--` form", () => {
    // `-y` after --command is a typo risk, not a server arg. The `--` form is
    // the supported way to pass flag-shaped arguments through.
    expect(() => addArgs("rg --command npx -y pkg")).toThrow(/Unknown flag "-y"/);
    const { parsed, rest } = addArgs("rg -- npx -y pkg");
    expect(transportFromArgs(parsed, rest)).toMatchObject({ args: ["-y", "pkg"] });
  });

  it("rejects http without a url", () => {
    const { parsed, rest } = addArgs("x --transport http");
    expect(() => transportFromArgs(parsed, rest)).toThrow(/requires --url/);
  });

  it("rejects a non-http url scheme", () => {
    const { parsed, rest } = addArgs("x --url ftp://nope.example");
    expect(() => transportFromArgs(parsed, rest)).toThrow(/must be http/);
  });

  it("rejects a stdio add with no command at all", () => {
    const { parsed, rest } = addArgs("x");
    expect(() => transportFromArgs(parsed, rest)).toThrow(/No command given/);
  });

  it("rejects an unknown transport", () => {
    const { parsed, rest } = addArgs("x --transport carrier-pigeon");
    expect(() => transportFromArgs(parsed, rest)).toThrow(/Unknown --transport/);
  });
});

describe("key/value flags", () => {
  it("keeps `=` inside an env value", () => {
    expect(parseEnvPairs(["DSN=postgres://u:p@h/db?a=b"])).toEqual({
      DSN: "postgres://u:p@h/db?a=b",
    });
  });

  it("parses `Key: Value` headers and keeps `=` in the value", () => {
    expect(parseHeaderPairs(["Authorization: Bearer a=b"])).toEqual({
      Authorization: "Bearer a=b",
    });
  });

  it("also accepts Key=Value headers", () => {
    expect(parseHeaderPairs(["X-Api-Key=secret"])).toEqual({ "X-Api-Key": "secret" });
  });

  it("rejects an env pair with no `=`", () => {
    expect(() => parseEnvPairs(["NOPE"])).toThrow(/expected KEY=VALUE/);
  });
});
