/**
 * Headless screenshot runner for Dispatch — drives the ALREADY-RUNNING
 * server and writes labeled PNGs. It never starts/stops the server.
 *
 *   node tools/verify/shot.mjs --base http://127.0.0.1:4319 --out .verify-shots --flow app
 *   node tools/verify/shot.mjs --flow panels
 *   node tools/verify/shot.mjs --flow all
 *
 * Flows: app | chat | panels | newproject | all  (add one in a few lines — see FLOWS below).
 * Screenshots land in --out (default: <repoRoot>/.verify-shots), numbered
 * `NN-<label>.png`. Prints every saved path + byte size.
 */
import {
  createHarness,
  assertServerUp,
  gotoApp,
  ensureChatOpen,
  panelTabs,
  DEFAULT_BASE,
  createChat,
  deleteChat,
  selectChatByTitle,
  driveChat,
  summarizeRow,
  listMemory,
  deleteMemory,
} from "./lib.mjs";

function parseArgs(argv) {
  const args = {
    base: DEFAULT_BASE,
    out: undefined,
    flow: "app",
    scale: 2,
    help: false,
    // --- drive flow ---
    project: undefined,
    prompt: undefined,
    mode: "bypass",
    title: undefined,
    cleanup: false,
    timeout: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--flow") args.flow = argv[++i];
    else if (a === "--scale") args.scale = Number(argv[++i]) || 2;
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--mode") args.mode = argv[++i];
    else if (a === "--title") args.title = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]) || 120_000;
    else if (a === "--cleanup") args.cleanup = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

/**
 * Each flow: `async (ctx) => void`, where ctx = the harness returned by
 * createHarness (page, shot, base, …). Keep them short and resilient.
 */
const FLOWS = {
  // Load the app and screenshot the loaded shell.
  async app(ctx) {
    await gotoApp(ctx.page, ctx.base);
    await ctx.shot("app-loaded");
  },

  // Select the first chat and screenshot the transcript + right panel.
  async chat(ctx) {
    await gotoApp(ctx.page, ctx.base);
    const ok = await ensureChatOpen(ctx.page);
    if (!ok) {
      console.warn("[verify] no chats in the sidebar — screenshotting the empty state");
      await ctx.shot("chat-none");
      return;
    }
    await ctx.shot("chat-transcript");
  },

  // Cycle the RightPanel tabs (Worktrees / Apps / Terminals / PRs / …) and
  // screenshot each. Tabs are discovered live, so new ones are covered for free.
  async panels(ctx) {
    await gotoApp(ctx.page, ctx.base);
    const ok = await ensureChatOpen(ctx.page);
    if (!ok) {
      console.warn("[verify] no chats — the RightPanel only renders with a chat selected");
      await ctx.shot("panels-nochat");
      return;
    }
    const tabs = panelTabs(ctx.page);
    const count = await tabs.count();
    if (count === 0) {
      console.warn("[verify] no RightPanel tabs found");
      await ctx.shot("panels-notabs");
      return;
    }
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      const raw = (await tab.textContent()) ?? "";
      const label = raw.replace(/\s+/g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase() || `tab-${i}`;
      await tab.click();
      await ctx.page.waitForTimeout(350);
      await ctx.shot(`panel-${label}`);
    }
  },

  // Walk the new-project page: the name→path derivation, the live project.yaml
  // preview, and the path probe's verdict for a repo that already exists.
  //
  // Creates NOTHING — it never presses either button — so it's safe to run
  // against a live install.
  async newproject(ctx) {
    await gotoApp(ctx.page, ctx.base);
    // Via the command palette: the one entry point that works with no project.
    await ctx.page.keyboard.press("Control+k");
    await ctx.page.waitForTimeout(300);
    await ctx.page.keyboard.type("new project");
    await ctx.page.waitForTimeout(400);
    await ctx.page.keyboard.press("Enter");
    await ctx.page.waitForTimeout(700);
    await ctx.shot("newproject-empty");

    // Typing the name should fill the path and grow the yaml beside it.
    await ctx.page.getByPlaceholder("Acme Billing").fill("Zombie Arena");
    await ctx.page.waitForTimeout(900);
    await ctx.shot("newproject-named");

    // A profile + a sub-app row: everything on the left lands on the right.
    await ctx.page.getByText("Review", { exact: true }).first().click();
    await ctx.page.getByPlaceholder("web").first().fill("game");
    await ctx.page.getByPlaceholder("apps/web").first().fill("apps/client");
    await ctx.page.getByPlaceholder("pnpm dev").first().fill("pnpm dev");
    await ctx.page.getByPlaceholder("5173").first().fill("5173");
    await ctx.page.waitForTimeout(600);
    await ctx.shot("newproject-configured");

    // Point it at this very repo — the probe should flip to "existing git repo".
    await ctx.page.getByPlaceholder(/acme-billing$/).fill(process.cwd().replace(/\\/g, "/"));
    await ctx.page.waitForTimeout(1200);
    await ctx.shot("newproject-existing-repo");
  },

  // Drive a REAL agent turn end-to-end: create a chat under a project, send a
  // prompt through the UI, wait for the turn to finish, and capture the
  // transcript. Makes a genuine LLM call — use for MCP-tool smoke tests.
  //
  //   node tools/verify/shot.mjs --flow drive --project <id> \
  //     --prompt "…" [--mode bypass] [--title "MCP smoke"] [--cleanup]
  //
  // Prints every finalized transcript row (summarized) so the caller can confirm
  // the tool cards succeeded, and (when --project) dumps the project's memory
  // before + after so a remember/forget round-trip is observable.
  async drive(ctx, args) {
    if (!args.project) throw new Error("--flow drive requires --project <projectId>");
    if (!args.prompt) throw new Error("--flow drive requires --prompt <text>");

    const title = args.title ?? `MCP smoke ${new Date().toISOString().slice(11, 19)}`;
    console.log(`[verify] creating chat "${title}" in project ${args.project} (mode ${args.mode})`);
    const chat = await createChat(ctx.base, {
      projectId: args.project,
      title,
      modeId: args.mode,
    });
    console.log(`[verify] chat id ${chat.id}`);

    const memBefore = await listMemory(ctx.base, args.project).catch(() => []);
    console.log(`[verify] memory before: [${memBefore.map((m) => m.name).join(", ")}]`);

    try {
      await gotoApp(ctx.page, ctx.base);
      await selectChatByTitle(ctx.page, title);
      await ctx.shot("drive-selected");

      console.log(`[verify] sending prompt + awaiting idle (timeout ${args.timeout}ms)…`);
      const rows = await driveChat(ctx.page, ctx.base, chat.id, args.prompt, {
        timeoutMs: args.timeout,
      });

      await ctx.page.waitForTimeout(800);
      await ctx.shot("drive-transcript", { fullPage: true });

      console.log(`\n[verify] transcript (${rows.length} rows):`);
      for (const r of rows) console.log(`   ${summarizeRow(r)}`);

      const memAfter = await listMemory(ctx.base, args.project).catch(() => []);
      console.log(`\n[verify] memory after: [${memAfter.map((m) => m.name).join(", ")}]`);

      // Screenshot the Memory panel so the add/remove is visible in the UI too.
      const memTab = ctx.page.locator("aside").last().getByRole("tab", { name: /memory/i }).first();
      if (await memTab.count()) {
        await memTab.click();
        await ctx.page.waitForTimeout(400);
        await ctx.shot("drive-memory-panel");
      }
    } finally {
      if (args.cleanup) {
        // Best-effort cleanup: drop any `mcp-smoke` memory + the smoke chat.
        await deleteMemory(ctx.base, args.project, "mcp-smoke").catch(() => {});
        await deleteChat(ctx.base, chat.id).catch(() => {});
        console.log(`[verify] cleaned up chat ${chat.id} + mcp-smoke memory`);
      }
    }
  },
};

function usage() {
  console.log(
    [
      "Headless screenshot harness for Dispatch (drives the running server).",
      "",
      "  node tools/verify/shot.mjs [--base <url>] [--out <dir>] [--flow <name>] [--scale <n>]",
      "",
      `  --base   base URL of the running server (default ${DEFAULT_BASE})`,
      "  --out    output dir for PNGs        (default <repoRoot>/.verify-shots)",
      `  --flow   ${Object.keys(FLOWS).join(" | ")} | all   (default app)`,
      "  --scale  device scale factor        (default 2)",
      "",
      "  drive flow (real agent turn):",
      "  --project <id>   project to create the chat under (required)",
      "  --prompt  <text> message to send                  (required)",
      "  --mode    <id>   chat mode                         (default bypass)",
      "  --title   <text> chat title                        (default 'MCP smoke …')",
      "  --timeout <ms>   idle wait cap                      (default 120000)",
      "  --cleanup        delete the smoke chat + mcp-smoke memory afterward",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const flows = args.flow === "all" ? Object.keys(FLOWS) : [args.flow];
  for (const f of flows) {
    if (!FLOWS[f]) {
      throw new Error(`unknown flow "${f}" — known: ${Object.keys(FLOWS).join(", ")}, all`);
    }
  }

  await assertServerUp(args.base);

  const ctx = await createHarness({ base: args.base, out: args.out, scale: args.scale });
  try {
    for (const f of flows) {
      console.log(`[verify] flow: ${f}  (base ${ctx.base})`);
      await FLOWS[f](ctx, args);
    }
  } finally {
    await ctx.close();
  }

  console.log(`\n[verify] ${ctx.saved.length} screenshot(s) -> ${ctx.dir}`);
  for (const s of ctx.saved) console.log(`  ${s.file}  (${s.bytes} bytes)`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[verify] failed:", err?.message ?? err);
    process.exit(1);
  },
);
