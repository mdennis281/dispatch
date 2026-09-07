import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  autostartPlan,
  disableAutostart,
  enableAutostart,
  parseArgs,
} from "./autostart.mjs";

/**
 * Fixtures are rooted per platform rather than sharing one literal path: a
 * `C:\\...` string is a RELATIVE path on Linux, where this suite actually runs.
 */
const WINDOWS = {
  platform: "win32",
  root: "C:\\Users\\ada\\AppData\\Local\\claude-manager",
  interpreter: "C:\\Python312\\pythonw.exe",
  home: "C:\\Users\\ada",
  env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
};
const POSIX = {
  root: "/home/ada/.local/share/claude-manager",
  interpreter: "/home/ada/.pyenv/versions/3.12.4/bin/python3",
  home: "/home/ada",
};

test("every platform's entry runs the payload launcher without opening a window", () => {
  const plans = [
    autostartPlan(WINDOWS),
    autostartPlan({ ...POSIX, platform: "darwin" }),
    autostartPlan({ ...POSIX, platform: "linux", systemd: true }),
    autostartPlan({ ...POSIX, platform: "linux", systemd: false }),
  ];
  for (const plan of plans) {
    assert.ok(
      plan.launcher.endsWith("launch.py"),
      `${plan.kind} should run launch.py, got ${plan.launcher}`,
    );
    assert.ok(plan.args.includes("--no-window"), `${plan.kind} must not open a browser at login`);
    // Pinned to the root it was installed into, so a --target install does not
    // wake up whatever happens to live at the default location.
    assert.ok(plan.args.includes("--target"), `${plan.kind} must pin its install root`);
  }
});

test("the Windows entry is a Startup-folder shortcut, backslashed off-Windows", () => {
  const plan = autostartPlan(WINDOWS);
  assert.equal(plan.kind, "startup-shortcut");
  assert.equal(
    plan.path,
    "C:\\Users\\ada\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Dispatch.lnk",
  );
  assert.equal(plan.target, WINDOWS.interpreter);
  assert.equal(plan.args[0], `${WINDOWS.root}\\app\\tools\\app\\launch.py`);
  assert.deepEqual(plan.args.slice(1), ["--no-window", "--target", WINDOWS.root]);
});

test("a redirected Startup folder wins over the guessed one", () => {
  const redirected = "D:\\OneDrive\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup";
  const plan = autostartPlan({ ...WINDOWS, startupDir: redirected });
  assert.equal(plan.path, `${redirected}\\Dispatch.lnk`);
});

test("the LaunchAgent starts at load and is never kept alive", () => {
  const plan = autostartPlan({ ...POSIX, platform: "darwin" });
  assert.equal(plan.kind, "launch-agent");
  assert.equal(plan.path, "/home/ada/Library/LaunchAgents/com.dispatch.app.plist");
  assert.match(plan.contents, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // launch.py detaches and exits 0; KeepAlive would read that as a crash loop.
  assert.match(plan.contents, /<key>KeepAlive<\/key>\s*<false\/>/);
  // The interpreter is absolute because launchd's PATH would not find `python3`.
  assert.match(plan.contents, /<array>\s*<string>\/home\/ada\/\.pyenv[^<]*python3<\/string>/);
});

test("the plist escapes a home directory that is legal XML but not legal markup", () => {
  const plan = autostartPlan({
    ...POSIX,
    platform: "darwin",
    home: "/home/a&b",
    root: "/home/a&b/dispatch",
  });
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(plan.contents), plan.contents);
  assert.match(plan.contents, /home\/a&amp;b\/dispatch\/app/);
});

test("the systemd unit survives an ExecStart that returns, and stops gracefully", () => {
  const plan = autostartPlan({ ...POSIX, platform: "linux", systemd: true });
  assert.equal(plan.kind, "systemd-user");
  assert.equal(plan.path, "/home/ada/.config/systemd/user/dispatch.service");
  assert.match(plan.contents, /^Type=oneshot$/m);
  assert.match(plan.contents, /^RemainAfterExit=yes$/m);
  assert.match(plan.contents, /^WantedBy=default\.target$/m);
  assert.match(plan.contents, /^ExecStart=.*--no-window.*$/m);
  assert.match(plan.contents, /^ExecStop=.*--stop.*$/m);
  // Quoted, so an install root with a space in it is one argument.
  assert.match(plan.contents, /^ExecStart="\/home\/ada\/\.pyenv[^"]*python3" "/m);
});

test("XDG_CONFIG_HOME relocates the unit", () => {
  const plan = autostartPlan({
    ...POSIX,
    platform: "linux",
    systemd: true,
    env: { XDG_CONFIG_HOME: "/home/ada/cfg" },
  });
  assert.equal(plan.path, "/home/ada/cfg/systemd/user/dispatch.service");
});

test("Linux without systemd falls back to an XDG autostart entry", () => {
  const plan = autostartPlan({ ...POSIX, platform: "linux", systemd: false });
  assert.equal(plan.kind, "xdg-autostart");
  assert.equal(plan.path, "/home/ada/.config/autostart/dispatch.desktop");
  assert.match(plan.contents, /^Type=Application$/m);
  assert.match(plan.contents, /^Exec=\/home\/ada\/\.pyenv[^\n]*--no-window/m);
});

test("a path with a space is quoted in the desktop entry's Exec line", () => {
  const plan = autostartPlan({
    ...POSIX,
    platform: "linux",
    systemd: false,
    root: "/home/ada/my apps/dispatch",
  });
  assert.match(plan.contents, /"\/home\/ada\/my apps\/dispatch\/app\/tools\/app\/launch\.py"/);
  assert.match(plan.contents, /"\/home\/ada\/my apps\/dispatch"/);
});

test("enable writes the entry and disable takes it back off", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-autostart-"));
  try {
    // An xdg-autostart plan is the one kind whose enable/disable is pure
    // filesystem work — no launchctl, no systemctl, nothing to stub.
    const plan = {
      ...autostartPlan({ ...POSIX, platform: "linux", systemd: false }),
      path: join(dir, "nested", "dispatch.desktop"),
    };
    const noop = () => {};
    enableAutostart(plan, { log: noop });
    assert.ok(existsSync(plan.path));
    assert.equal(readFileSync(plan.path, "utf8"), plan.contents);

    assert.equal(disableAutostart(plan, { log: noop }), true);
    assert.equal(existsSync(plan.path), false);
    // Removing what is already gone is a success, not an error.
    assert.equal(disableAutostart(plan, { log: noop }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disable unregisters the unit even when its file is already gone", () => {
  // `systemctl enable` drops a symlink in default.target.wants/, and THAT is
  // what starts Dispatch. Deleting the unit file by hand leaves it behind, so
  // gating the systemctl call on the file existing would leave autostart on
  // for the one person who reaches for --disable a second time.
  const plan = {
    ...autostartPlan({ ...POSIX, platform: "linux", systemd: true }),
    // The fixture's path is fictional; keep the rmSync below aimed at a name
    // that cannot collide with anything on the machine running this.
    path: join(tmpdir(), "dispatch-autostart-absent", "dispatch.service"),
  };
  const ran = [];
  const runQuiet = (command, args) => ran.push([command, ...args].join(" "));

  assert.equal(disableAutostart(plan, { log: () => {}, runQuiet }), false);
  assert.deepEqual(ran, [
    "systemctl --user disable --now dispatch.service",
    "systemctl --user daemon-reload",
  ]);
});

test("disabling a LaunchAgent boots out the job launchd already loaded", () => {
  const plan = {
    ...autostartPlan({ ...POSIX, platform: "darwin" }),
    path: join(tmpdir(), "dispatch-autostart-absent", "com.dispatch.app.plist"),
  };
  const ran = [];
  disableAutostart(plan, { log: () => {}, runQuiet: (c, a) => ran.push([c, ...a].join(" ")) });
  assert.equal(ran.length, 1);
  assert.match(ran[0], /^launchctl bootout gui\/.*\/com\.dispatch\.app$/);
});

test("the CLI defaults to reporting, and rejects a --target with no value", () => {
  assert.deepEqual(parseArgs([]), { mode: "status", activate: true });
  assert.equal(parseArgs(["--enable"]).mode, "enable");
  assert.equal(parseArgs(["--disable"]).mode, "disable");
  assert.equal(parseArgs(["--enable", "--no-activate"]).activate, false);
  assert.equal(parseArgs(["--target", "/opt/dispatch"]).target, "/opt/dispatch");
  assert.throws(() => parseArgs(["--target"]), /--target requires a value/);
  assert.throws(() => parseArgs(["--target", "--enable"]), /--target requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});
