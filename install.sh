#!/usr/bin/env sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Dispatch requires Node.js 20 or newer. Install Node, then run this command again." >&2
  exit 1
fi

installer_url="${DISPATCH_INSTALLER_URL:-https://raw.githubusercontent.com/mdennis281/dispatch/main/tools/install.mjs}"
installer_path="$(mktemp "${TMPDIR:-/tmp}/dispatch-installer.XXXXXX.mjs")"
trap 'rm -f "$installer_path"' EXIT HUP INT TERM

echo "Downloading the Dispatch release installer..."
if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN}}" "$installer_url" -o "$installer_path"
else
  curl -fsSL "$installer_url" -o "$installer_path"
fi
node "$installer_path" "$@"
