#!/usr/bin/env node
/**
 * Undo `updatedAt` stamps left by background bookkeeping writes.
 *
 * Three worktree writers used to stamp `updatedAt: now` on chats they had no
 * business marking active — an attach, the reaper's detach, and the detector's
 * 4s reconcile. The sidebar sorts its Idle queue by `updatedAt`, so each such
 * write walked a long-finished chat back to the top of the list. The writers are
 * fixed; this repairs the records they already wrote.
 *
 * The truth it restores to is the transcript's mtime, which is what
 * `Store.lastActivityAt` derives `updatedAt` from anyway — so this only ever
 * moves a record to the value the store would compute for it untouched. A chat
 * with no transcript is SKIPPED: there is nothing truthful to fall back to, and
 * `createdAt` would be a different kind of lie.
 *
 * MUST run with the server stopped (`pnpm app:stop`). The store caches chat
 * records in memory for the process lifetime, so a live server would keep
 * serving — and eventually rewrite — the stale values this just corrected.
 *
 *   node tools/app/repair-chat-updatedat.mjs [--data <dir>] [--apply]
 *
 * Dry-run by default; `--apply` writes.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dataArg = args.indexOf("--data");
const dataDir =
  dataArg !== -1
    ? args[dataArg + 1]
    : join(process.env.LOCALAPPDATA ?? "", "claude-manager", "data");
const chatsDir = join(dataDir, "chats");

// A minute of slack: a chat written at the tail of its own turn is legitimately
// a hair ahead of the transcript it just appended to, and that is not damage.
const SLACK_MS = 60_000;

let scanned = 0;
let repaired = 0;
let noTranscript = 0;
const worst = [];

for (const id of readdirSync(chatsDir)) {
  const file = join(chatsDir, id, "chat.json");
  let chat;
  try {
    chat = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue; // not a chat dir, or mid-write
  }
  scanned++;
  if (typeof chat.updatedAt !== "number") continue;

  let mtime;
  try {
    mtime = Math.round(statSync(join(chatsDir, id, "messages.jsonl")).mtimeMs);
  } catch {
    noTranscript++;
    continue;
  }
  if (chat.updatedAt <= mtime + SLACK_MS) continue;

  const drift = chat.updatedAt - mtime;
  worst.push({ id, title: chat.title ?? "", drift, from: chat.updatedAt, to: mtime });
  repaired++;
  if (apply) {
    // Byte-for-byte the shape `writeJsonAtomic` produces — two-space indent, no
    // trailing newline — so a repaired file is indistinguishable from one the
    // store wrote, and the only diff is the field we came for.
    writeFileSync(file, JSON.stringify({ ...chat, updatedAt: mtime }, null, 2), "utf8");
  }
}

worst.sort((a, b) => b.drift - a.drift);
const days = (ms) => `${(ms / 86_400_000).toFixed(1)}d`;
for (const w of worst.slice(0, 10)) {
  console.log(`  ${days(w.drift).padStart(7)} ahead  ${new Date(w.from).toISOString()} -> ${new Date(w.to).toISOString()}  ${w.title.slice(0, 48)}`);
}
console.log(
  `\n${scanned} chats scanned, ${noTranscript} skipped (no transcript), ` +
    `${repaired} ${apply ? "repaired" : "would be repaired (dry run; pass --apply)"}`,
);
