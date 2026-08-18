#!/usr/bin/env sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Dispatch requires Node.js 24 or newer. Install Node, then run this command again." >&2
  exit 1
fi

release_tag=""
expect_version=0
for arg in "$@"; do
  if [ "$expect_version" -eq 1 ]; then
    release_tag="$arg"
    break
  fi
  if [ "$arg" = "--version" ]; then expect_version=1; fi
done
if [ -n "$release_tag" ] && [ "${release_tag#v}" = "$release_tag" ]; then
  release_tag="v$release_tag"
fi

if [ -n "${DISPATCH_INSTALLER_URL:-}" ]; then
  installer_url="$DISPATCH_INSTALLER_URL"
elif [ -n "$release_tag" ]; then
  installer_url="https://github.com/mdennis281/dispatch/releases/download/$release_tag/install.mjs"
else
  installer_url="https://github.com/mdennis281/dispatch/releases/latest/download/install.mjs"
fi
installer_path="$(mktemp "${TMPDIR:-/tmp}/dispatch-installer.XXXXXX.mjs")"
trap 'rm -f "$installer_path"' EXIT HUP INT TERM

echo "Downloading the Dispatch release installer..."
if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN}}" "$installer_url" -o "$installer_path"
else
  curl -fsSL "$installer_url" -o "$installer_path"
fi
# Leave a possibly-installed app/ working directory before the atomic swap.
# POSIX permits renaming a process's cwd, but Git Bash on Windows does not.
export DISPATCH_INSTALL_CWD="$PWD"
cd "${TMPDIR:-/tmp}"
node "$installer_path" "$@"
