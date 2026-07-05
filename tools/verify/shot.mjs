/**
 * Headless screenshot runner for claude-manager — drives the ALREADY-RUNNING
 * server and writes labeled PNGs. It never starts/stops the server.
 *
 *   node tools/verify/shot.mjs --base http://127.0.0.1:4319 --out .verify-shots --flow app
 *   node tools/verify/shot.mjs --flow panels
 *   node tools/verify/shot.mjs --flow all
 *
 * Flows: app | chat | panels | all   (add one in a few lines — see FLOWS below).
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
} from "./lib.mjs";

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, out: undefined, flow: "app", scale: 2, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--flow") args.flow = argv[++i];
    else if (a === "--scale") args.scale = Number(argv[++i]) || 2;
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
};

function usage() {
  console.log(
    [
      "Headless screenshot harness for claude-manager (drives the running server).",
      "",
      "  node tools/verify/shot.mjs [--base <url>] [--out <dir>] [--flow <name>] [--scale <n>]",
      "",
      `  --base   base URL of the running server (default ${DEFAULT_BASE})`,
      "  --out    output dir for PNGs        (default <repoRoot>/.verify-shots)",
      `  --flow   ${Object.keys(FLOWS).join(" | ")} | all   (default app)`,
      "  --scale  device scale factor        (default 2)",
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
      await FLOWS[f](ctx);
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
