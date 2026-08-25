/**
 * The resource snapshot — what Dispatch is costing this machine, and which chat
 * is costing it.
 *
 * WHY THIS EXISTS. The sidebar's process COUNT answers "how many", which turned
 * out to be the wrong question: nine cheap processes and nine expensive ones
 * look identical on the row. What actually maxes the box is a handful of chats
 * holding multi-gigabyte trees, and until it is measured the only signal is the
 * machine going unresponsive.
 *
 * THREE SCOPES, because "am I about to redline" and "who do I reap" are
 * different questions and only the first one is cheap:
 *
 *   • {@link SystemResources}   — the whole machine. Free: `os.cpus()` and
 *                                 `os.freemem()`, no subprocess, ~0.2 ms.
 *   • {@link DispatchResources} — Dispatch's own tree. Needs the process table.
 *   • {@link ChatResources}     — per chat, and per process within a chat.
 *
 * ── THE MEMORY NUMBER IS NOT WHAT IT LOOKS LIKE ──────────────────────────────
 *
 * `rssBytes` is RESIDENT SET (Windows working set / POSIX RSS), and resident set
 * counts SHARED pages once per process. Twelve `node` processes sharing one
 * runtime image each report their share of it. Measured on a real install:
 * summing working set over 124 node/claude processes gave 16,407 MB where the
 * true private total was 8,692 MB — an overstatement of 1.9x.
 *
 * The accurate figure (`WorkingSetPrivate`) lives in
 * `Win32_PerfRawData_PerfProc_Process`, which takes SEVEN SECONDS to enumerate.
 * That is not a price a poll can pay, so it is not collected.
 *
 * What that means for a reader:
 *   • RANKING chats against each other is sound — the overstatement is roughly
 *     uniform, so the biggest number really is the biggest chat.
 *   • The ABSOLUTE total is not; it will exceed what Task Manager attributes and
 *     can exceed physical RAM. {@link SHARED_PAGE_FACTOR} is the observed
 *     divisor, offered so the UI can show a corrected estimate, clearly labelled
 *     as an estimate.
 *
 * Every consumer of a byte figure here is expected to say which of the two it is
 * showing. The UI defaults to relative (share of a total) for exactly this
 * reason, with absolutes behind a toggle.
 */

/**
 * Observed resident-set overstatement from shared pages.
 *
 * Divide a summed `rssBytes` by this for an order-of-magnitude honest estimate
 * of real private memory. Measured at 1.89x across 124 node/claude processes on
 * a live install; call it 1.9. It is a CALIBRATION, not a constant of nature —
 * a tree of processes sharing more (or less) will sit either side of it, so it
 * must never be presented as an exact figure.
 */
export const SHARED_PAGE_FACTOR = 1.9;

/** One process, with what it is costing. */
export interface ProcessSample {
  pid: number;
  ppid: number;
  /** Image name, e.g. `node.exe`. */
  name?: string;
  /** Resident bytes. Counts shared pages — see the module note. */
  rssBytes: number;
  /**
   * Share of ONE core, as a percent, over {@link ResourceSnapshot.windowMs}.
   * Can exceed 100 on a multi-threaded process. `null` until a second sample
   * exists to difference against — a cumulative counter cannot yield a rate.
   */
  cpuPct: number | null;
}

/** A process attributed to a chat, for the per-chat drill-down. */
export interface ChatProcessSample extends ProcessSample {
  /** Which half of the chat's tree this belongs to. */
  kind: "session" | "shell";
}

/**
 * The one image name accounting for most of a chat's cost, and how many of it
 * there are — "chrome.exe ×17".
 *
 * WHY A ROW NEEDS THIS. A percentage tells you a chat is expensive; it does not
 * tell you what to do about it. The case that motivated it: a chat pinning ten
 * cores turned out to be a headless Chrome the Playwright MCP had left running,
 * rendering through swiftshader — software rasterization, so a "GPU process"
 * burning CPU. The row said "65%" and the actionable fact ("chrome.exe ×17")
 * was hidden behind an expand nobody had a reason to click.
 *
 * AGGREGATED BY NAME, not per pid: seventeen Chrome processes at 60% each are
 * one problem, and listing the biggest single pid would understate it and name
 * an arbitrary member of the group.
 */
export interface HotProcess {
  /** Image name, e.g. `chrome.exe`. */
  name: string;
  /** How many processes of that name are in this tree. */
  count: number;
  /** Their combined share of ONE core, or `null` if unmeasured. */
  cpuPct: number | null;
  /** Their combined resident bytes. */
  rssBytes: number;
}

/** What one chat's whole tree is costing. */
export interface ChatResources {
  chatId: string;
  /** Processes in the tree, both kinds. */
  procs: number;
  rssBytes: number;
  /** Summed over the tree; `null` while the first delta is still pending. */
  cpuPct: number | null;
  /** The session subtree alone — the half an idle sweep will reclaim. */
  session: { procs: number; rssBytes: number; cpuPct: number | null };
  /** Background shells — never swept automatically. */
  shells: { procs: number; rssBytes: number; cpuPct: number | null };
  /**
   * The dominant image in this tree — by CPU when anything is measurable,
   * otherwise by memory. Absent for a tree we could not name anything in.
   */
  hottest: HotProcess | null;
}

/**
 * Dispatch's total footprint: the server process and everything under it.
 *
 * Every session and every background shell is spawned as a descendant of the
 * server, so one subtree walk covers the lot — measured at 349 processes and
 * 20.3 GB of working set on a live install, against a server process that was
 * itself only 362 MB. The DB needs no separate accounting: `node:sqlite` runs
 * IN-PROCESS, so it is already inside `serverRssBytes`.
 */
export interface DispatchResources {
  /** Server pid — the root of the tree. */
  pid: number;
  /** Processes in the whole tree, inclusive of the server. */
  procs: number;
  rssBytes: number;
  cpuPct: number | null;
  /** The server process ALONE, DB included. Its own overhead, not its chats'. */
  serverRssBytes: number;
  serverCpuPct: number | null;
  /**
   * The part of the tree no chat accounts for — sub-app runners, the server
   * itself, anything orphaned mid-teardown. `tree − Σ chats`, so a number that
   * climbs here is the signal that something is leaking outside a chat.
   *
   * CARRIES CPU, not just a process count and bytes. Without it a runaway that
   * belongs to no chat — a sub-app runner spinning, a dev server in a loop —
   * appears in the machine total and on no row anywhere, which is the one
   * failure a page called "Resources" cannot have.
   */
  unattributed: { procs: number; rssBytes: number; cpuPct: number | null };
}

/** The whole machine. Free to collect; see the module note. */
export interface SystemResources {
  /** Busy percent across all cores over {@link ResourceSnapshot.windowMs}. */
  cpuPct: number | null;
  logicalCores: number;
  totalBytes: number;
  freeBytes: number;
  /** `total − free`. What the OS says is in use, by anything. */
  usedBytes: number;
}

/** One reading of everything. */
export interface ResourceSnapshot {
  system: SystemResources;
  /** Absent when the server's own pid could not be resolved in the table. */
  dispatch: DispatchResources | null;
  /** Per chat, biggest first. A chat holding nothing is absent. */
  chats: ChatResources[];
  /** When it was taken (epoch ms). */
  at: number;
  /**
   * The interval the CPU percentages are averaged over, in ms — the gap back to
   * the previous sample. 0 when there was no previous sample, which is also
   * when every `cpuPct` is `null`.
   *
   * Reported rather than assumed because the sampler is DEMAND-DRIVEN: it runs
   * when someone is looking, so the window is however long ago that last was.
   * A percentage over an undisclosed interval is not a measurement.
   */
  windowMs: number;
}

/** The per-process drill-down for one chat. Ordered biggest-first. */
export interface ChatProcessDetail {
  chatId: string;
  procs: ChatProcessSample[];
  at: number;
  windowMs: number;
}
