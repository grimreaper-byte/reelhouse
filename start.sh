#!/bin/sh
# Starts Reelhouse on Linux (or macOS): ./start.sh, from anywhere. Stop it with Ctrl+C.
#
# Needs Node.js 22.13 or newer and ffmpeg (Debian/Ubuntu: sudo apt install ffmpeg). The packages Reelhouse uses are
# installed the first time, and again after an update that changes them.
#
# Settings such as the port are in the web app. The environment variables in the README's Configuration table can
# be set first, e.g. PORT=8585 ./start.sh. To start Reelhouse with the computer, use deploy/reelhouse.service.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed, or isn't on the PATH. Install Node.js 22.13 or newer (https://nodejs.org) and run this again." >&2
  exit 1
fi
if ! node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)"; then
  echo "Reelhouse needs Node.js 22.13 or newer; this is $(node -v). Install a newer one (https://nodejs.org) and run this again." >&2
  exit 1
fi
command -v ffmpeg >/dev/null 2>&1 \
  || echo "Note: ffmpeg isn't on the PATH. Install it (sudo apt install ffmpeg), or set its path in Settings > Transcoder."

# First run, or an update that changed the packages: install them as the lock file says.
if ! npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
  echo "Installing Reelhouse's packages..."
  npm ci --omit=dev
fi

exec node --disable-warning=ExperimentalWarning server/index.js
