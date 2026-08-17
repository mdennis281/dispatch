#!/usr/bin/env python3
"""
Start Dispatch and open it in its own PWA window.

── What replaced Electron ──────────────────────────────────────────────────
Dispatch used to ship a branded Electron shell that did two unrelated jobs:
it was a browser window, and it was the server's supervisor. An installed PWA
does the first job better — Chromium gives the app its own window, taskbar
identity and icon, with no 270MB runtime copied per version and no rcedit
stamping. This script does the second, in about 200 lines.

Supervising still matters, and this is the part that is easy to get wrong.
Windows cannot deliver SIGTERM: `os.kill(pid, SIGTERM)` maps to
TerminateProcess, which kills abruptly and runs no handler. The server would
then never reach `services.dispose()` → `runner.stopAll()`, and every subApp
dev server it spawned would be left orphaned holding its port. The server's ONE
graceful path on Windows is the stdin protocol it already speaks
(DISPATCH_IPC=1, see packages/server/src/shutdown.ts) — and that needs a living
parent holding the pipe. So a supervisor process has to exist. It just doesn't
have to be 270MB.

── Lifecycle ───────────────────────────────────────────────────────────────
Closing the PWA window does NOT stop the server, deliberately: the old shell
hid its window on close for exactly this reason, because a reflex Alt-F4 must
not kill a long-running agent. Agents keep working; run with --stop when you
actually mean it.

Usage:
  launch.py                 start if needed, then open the app window
  launch.py --stop          ask the running server to shut down (stops agents)
  launch.py --status        report what is running, and exit
  launch.py --no-window     start the server without opening a window
  launch.py --app-dir DIR   run a checkout instead of the installed payload
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

# ---------------------------------------------------------------- paths
# MIRROR of tools/app/paths.mjs. Keep the two in sync — they are small on
# purpose, and publish.mjs reads the same runtime.json this writes.

EXE_SUFFIX = ".exe" if sys.platform == "win32" else ""
IS_WINDOWS = sys.platform == "win32"

#: Default port. 4318, not the server's own 4319: the installed app has to
#: coexist with a `pnpm dev` instance rather than fight it for a port.
DEFAULT_PORT = 4318
#: How far to scan for a free port before giving up.
PORT_SCAN = 10
#: How long to wait for the server to answer before calling the start failed.
START_TIMEOUT_S = 60
#: How long to give the server to tear down before we stop waiting on it.
#: Matches SHUTDOWN_GRACE_MS in packages/server/src/shutdown.ts, plus slack.
STOP_TIMEOUT_S = 25


def desktop_root() -> Path:
    """Root of the installed deployment. DISPATCH_HOME overrides, as in paths.mjs."""
    home = os.environ.get("DISPATCH_HOME") or os.environ.get("CM_HOME")
    if home:
        return Path(home).resolve()
    if IS_WINDOWS:
        local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData/Local")
    elif sys.platform == "darwin":
        local = str(Path.home() / "Library/Application Support")
    else:
        local = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    # Still literally `claude-manager`: renaming it would strand every existing
    # chat transcript behind a migration. See the note in paths.mjs.
    return Path(local) / "claude-manager"


class Paths:
    def __init__(self, root: Path):
        self.root = root
        self.app = root / "app"
        self.data_dir = root / "data"
        self.config_dir = root / "config"
        self.backups = root / "backups"
        self.stamp = root / "current.json"
        self.runtime = root / "runtime.json"
        #: Written by tools/app/upgrade.mjs. Read here only to tell a user whose
        #: payload is missing what actually happened to it.
        self.upgrade_state = root / "upgrade.json"
        #: How `--stop` reaches a supervisor it has no handle on. A sentinel
        #: file is crude, but it is the one channel that works across detached
        #: processes on Windows without opening a control port on localhost.
        self.stop_request = root / "shutdown.request"


# ---------------------------------------------------------------- probes


def port_alive(port: int, timeout: float = 1.5) -> bool:
    """Can we open a TCP connection to this port? (i.e. is something really up)"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def read_json(path: Path) -> dict | None:
    """Parse a small JSON file, or None if it's absent, truncated or not an object."""
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def read_runtime(paths: Paths) -> dict | None:
    """The live instance's advertisement, or None if absent/unreadable/stale."""
    rt = read_json(paths.runtime)
    if rt is None:
        return None
    port = rt.get("port")
    # runtime.json survives a hard crash, so the file alone proves nothing —
    # only a real connection does.
    if isinstance(port, int) and port_alive(port):
        return rt
    return None


def find_free_port(start: int) -> int:
    for port in range(start, start + PORT_SCAN):
        if not port_alive(port, timeout=0.4):
            return port
    raise SystemExit(f"no free port in {start}..{start + PORT_SCAN - 1}")


def resolve_app_dir(paths: Paths, override: str | None) -> Path:
    if override:
        app = Path(override).resolve()
    else:
        app = paths.app
    entry = app / "packages" / "server" / "dist" / "index.js"
    if not entry.exists():
        raise SystemExit(f"no built server at {entry}\n{_missing_payload_remedy(paths, app)}")
    return app


def _missing_payload_remedy(paths: Paths, app: Path) -> str:
    """
    What to actually do about a missing payload.

    The generic advice is worse than useless after an interrupted upgrade: a
    swap killed mid-move leaves app/ ABSENT with the only good build under
    backups/, and `pnpm app:publish` would see no payload, clone a fresh one,
    cold-build for ten minutes and silently abandon the good one sitting right
    there. So when there is evidence of an upgrade, point at the backup.
    """
    if app == paths.app:
        state = read_json(paths.upgrade_state) or {}
        backup = state.get("backup")
        if not (isinstance(backup, str) and Path(backup).exists()):
            found = sorted(
                (d for d in paths.backups.glob("app-*") if d.is_dir()),
                key=lambda d: d.name,
            )
            backup = str(found[-1]) if found else None
        if backup:
            return (
                f"  An upgrade left this install mid-swap (phase: {state.get('phase', 'unknown')}).\n"
                f"  The previous payload is still here:\n"
                f"    {backup}\n"
                f"  Put it back:  pnpm app:upgrade -- --recover\n"
                f"  Do NOT run `pnpm app:publish` first - it would clone a fresh payload\n"
                f"  and leave that one stranded."
            )
    return (
        "  Publish the payload first:  pnpm app:publish\n"
        "  Or point at a checkout:     launch.py --app-dir <repo>"
    )


# ---------------------------------------------------------------- supervise


def supervise(paths: Paths, app: Path, port: int) -> int:
    """
    Run the server as a child and hold its stdin, so shutdown can be graceful.

    This is the blocking half, re-launched detached by `start()`. It owns
    runtime.json for its whole lifetime: written once the port answers, removed
    on the way out IF IT IS STILL OURS (see _release_runtime), so publish.mjs
    never sees a live app as stale (or the reverse).
    """
    node = shutil.which("node")
    if not node:
        raise SystemExit("node is not on PATH - install Node 20+ and retry")

    paths.data_dir.mkdir(parents=True, exist_ok=True)
    paths.config_dir.mkdir(parents=True, exist_ok=True)
    paths.stop_request.unlink(missing_ok=True)

    env = {
        **os.environ,
        # Makes the server read stdin for "shutdown" — the only graceful stop
        # available on Windows. Without it this supervisor has no polite verb.
        "DISPATCH_IPC": "1",
        "DISPATCH_PORT": str(port),
        # Installed Dispatch is intentionally reachable on the LAN. Health
        # probes and the PWA URL below stay loopback so localhost remains the
        # secure browser origin; dev/default server launches remain unchanged.
        "DISPATCH_HOST": "0.0.0.0",
        "DISPATCH_DATA_DIR": str(paths.data_dir),
        "DISPATCH_CONFIG_DIR": str(paths.config_dir),
    }

    node_kwargs: dict = {}
    if IS_WINDOWS:
        # CREATE_NO_WINDOW, and it is the difference between a console window
        # sitting on the desktop for the entire life of the app and no window at
        # all. This supervisor is started DETACHED_PROCESS under pythonw, so it
        # owns no console — and a console-subsystem child spawned from a
        # console-less parent gets a NEW one, with a visible window, which is
        # then the thing that "sticks around after an upgrade". Note this cannot
        # be fixed at the supervisor: it is node, not python, that Windows is
        # allocating the console for.
        #
        # Nothing is lost. stdout/stderr were already going nowhere here (see
        # below), so this only stops Windows from drawing the void.
        node_kwargs["creationflags"] = 0x08000000

    proc = subprocess.Popen(
        [node, "dist/index.js"],
        cwd=str(app / "packages" / "server"),
        env=env,
        stdin=subprocess.PIPE,
        # stdout/stderr are inherited: under pythonw there is no console, so
        # they go nowhere, and the server's own log files remain the record.
        **node_kwargs,
    )

    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + START_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return proc.returncode or 1
        if port_alive(port, timeout=0.5):
            break
        time.sleep(0.25)
    else:
        proc.kill()
        raise SystemExit(f"server did not answer on {port} within {START_TIMEOUT_S}s")

    paths.root.mkdir(parents=True, exist_ok=True)
    paths.runtime.write_text(
        json.dumps(
            {
                "pid": proc.pid,
                "supervisor": os.getpid(),
                "url": url,
                "port": port,
                "appDir": str(app),
                "startedAt": int(time.time() * 1000),
            },
            indent=2,
        ),
        "utf-8",
    )

    try:
        while proc.poll() is None:
            if paths.stop_request.exists():
                paths.stop_request.unlink(missing_ok=True)
                _ask_to_stop(proc)
                break
            time.sleep(1.0)
        # Either it exited on its own or we just asked it to; either way give
        # teardown its grace window before abandoning the wait.
        try:
            proc.wait(timeout=STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            proc.kill()
        return proc.returncode or 0
    finally:
        _release_runtime(paths)


def _release_runtime(paths: Paths) -> None:
    """
    Drop runtime.json only if it is still OURS.

    An unconditional unlink here was the worst bug in the upgrade path. Our
    teardown runs for up to STOP_TIMEOUT_S AFTER the server stopped listening,
    and an upgrade that watched the port (rather than this process) would by
    then have started a whole new instance — which had written its own
    runtime.json. Deleting it left a live, healthy server that `--stop`,
    `--status` and publish.mjs all reported as NOT RUNNING, and publish.mjs
    would then happily rebuild the payload in place underneath it.

    The file already carries the pid that wrote it, so this is just a
    compare-and-delete - and it deletes only on PROOF of ownership, never on a
    failed read: an unreadable runtime.json is a file some other process is
    halfway through writing at least as often as it is garbage, and leaving a
    stale one behind is a far milder failure than deleting a live one.

    Same reasoning for the stop sentinel: a stop aimed at the next instance must
    not be swallowed by our exit. (A leftover sentinel is harmless - supervise()
    clears it before starting anything.)
    """
    rt = read_json(paths.runtime)
    if rt is None or rt.get("supervisor") != os.getpid():
        return
    paths.runtime.unlink(missing_ok=True)
    paths.stop_request.unlink(missing_ok=True)


def _ask_to_stop(proc: subprocess.Popen) -> None:
    """Politely: this is what runs runner.stopAll() and kills every subApp."""
    try:
        assert proc.stdin is not None
        proc.stdin.write(b"shutdown\n")
        proc.stdin.flush()
    except (OSError, ValueError, AssertionError):
        # stdin already gone — nothing polite left to try; the caller's
        # wait/kill below is the backstop.
        pass


# ---------------------------------------------------------------- commands


def start(paths: Paths, app: Path, port: int) -> None:
    """Re-launch this script detached, as the supervisor, and wait for the port."""
    interpreter = sys.executable
    if IS_WINDOWS:
        # pythonw keeps a console window from flashing up when the Start-menu
        # shortcut fires. Fall back to python.exe if this build lacks it.
        cand = Path(interpreter).with_name("pythonw.exe")
        if cand.exists():
            interpreter = str(cand)

    argv = [interpreter, str(Path(__file__).resolve()), "--supervise", "--port", str(port)]
    argv += ["--app-dir", str(app)]
    # The supervisor owns runtime.json, so it must resolve the SAME root we did
    # — otherwise `--target` would start a server whose advertisement lands
    # somewhere `--stop` and publish.mjs never look.
    argv += ["--target", str(paths.root)]

    kwargs: dict = {"cwd": str(app)}
    if IS_WINDOWS:
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: outlive this shell, and
        # don't take a stray Ctrl-C aimed at whoever launched us.
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True

    subprocess.Popen(argv, **kwargs)

    # Wait for runtime.json, NOT merely for the port. Both processes are
    # watching the same port, so returning on that alone lets this one win the
    # race and hand back an instance that `--stop` and `--status` — which read
    # runtime.json — would report as not running.
    deadline = time.monotonic() + START_TIMEOUT_S
    while time.monotonic() < deadline:
        if read_runtime(paths):
            return
        time.sleep(0.25)
    raise SystemExit(f"server did not come up on {port} within {START_TIMEOUT_S}s")


def open_window(url: str) -> None:
    try:
        from pwa_launcher import open_pwa
    except ImportError:
        # Release installs intentionally require only Python itself. A dedicated
        # PWA window is nicer, but the standard-library browser fallback keeps a
        # Start-menu/PATH launcher useful on every supported platform.
        if not webbrowser.open(url):
            print(f"Dispatch is running; open {url}", file=sys.stderr)
        return

    from pwa_launcher import ChromiumNotFoundError

    try:
        # A dedicated profile under the app root, NOT auto_profile: the app is
        # long-lived and its window state, zoom and granted mic permission
        # should persist across launches rather than land in a fresh temp dir
        # every time.
        open_pwa(url, user_data_dir=desktop_root() / "browser-profile")
    except ChromiumNotFoundError:
        if not webbrowser.open(url):
            print(f"Dispatch is running; open {url}", file=sys.stderr)


def stop(paths: Paths) -> int:
    rt = read_runtime(paths)
    if not rt:
        print("Dispatch is not running.")
        return 0

    paths.root.mkdir(parents=True, exist_ok=True)
    paths.stop_request.write_text("stop", "utf-8")
    print(f"asked Dispatch to stop (pid {rt.get('pid')}) - stopping agents and subApps...")

    # Wait for the SUPERVISOR to let go, not merely for the port. The listener
    # closes FIRST and teardown (services.dispose -> runner.stopAll) runs after
    # it, with the supervisor holding a cwd inside app/ for the whole grace
    # window - so a dead port is the start of the shutdown, not the end. Both
    # `app:publish` and the upgrade's swap act on this answer.
    sup = rt.get("supervisor")
    deadline = time.monotonic() + STOP_TIMEOUT_S + 10
    while time.monotonic() < deadline:
        current = read_json(paths.runtime)
        # Its owner deletes it on the way out; a different owner means ours is
        # already gone and something new has taken the port.
        if current is None or (sup is not None and current.get("supervisor") != sup):
            print("stopped.")
            return 0
        # A payload older than the `supervisor` field: the port is all we have.
        if sup is None and not port_alive(rt["port"], timeout=0.5):
            print("stopped.")
            return 0
        time.sleep(0.5)

    print(
        f"still up after {STOP_TIMEOUT_S + 10}s - teardown may be wedged on a hung child.\n"
        f"  Check the Ports & processes panel, or kill pid {rt.get('pid')} by hand.",
        file=sys.stderr,
    )
    return 1


def status(paths: Paths) -> int:
    rt = read_runtime(paths)
    if not rt:
        print("Dispatch: not running")
        if paths.runtime.exists():
            print("  (a stale runtime.json is on disk - the app is not reachable)")
        return 1
    print(f"Dispatch: running at {rt['url']}")
    print(f"  pid       {rt.get('pid')}")
    print(f"  payload   {rt.get('appDir')}")
    if paths.stamp.exists():
        try:
            st = json.loads(paths.stamp.read_text("utf-8"))
            print(f"  published {str(st.get('sha'))[:12]}  \"{st.get('subject')}\"")
        except (OSError, ValueError):
            pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Start Dispatch and open its PWA window.")
    ap.add_argument("--stop", action="store_true", help="stop the running server")
    ap.add_argument("--status", action="store_true", help="report what is running")
    ap.add_argument("--no-window", action="store_true", help="start without opening a window")
    ap.add_argument("--app-dir", help="run this checkout instead of the installed payload")
    ap.add_argument("--port", type=int, help=f"port to serve on (default {DEFAULT_PORT})")
    ap.add_argument("--target", help="deployment root (overrides DISPATCH_HOME)")
    # Internal: the detached half. Not in the docstring because you never type it.
    ap.add_argument("--supervise", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    paths = Paths(Path(args.target).resolve() if args.target else desktop_root())

    if args.status:
        return status(paths)
    if args.stop:
        return stop(paths)

    if args.supervise:
        app = resolve_app_dir(paths, args.app_dir)
        return supervise(paths, app, args.port or DEFAULT_PORT)

    running = read_runtime(paths)
    if running:
        url = running["url"]
        print(f"Dispatch already running at {url}")
    else:
        app = resolve_app_dir(paths, args.app_dir)
        port = args.port or find_free_port(DEFAULT_PORT)
        print(f"starting Dispatch on {port}...")
        start(paths, app, port)
        url = f"http://127.0.0.1:{port}"
        print(f"Dispatch is up at {url}")

    if not args.no_window:
        open_window(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
