#!/usr/bin/env sh
# One-click start for macOS / Linux. Double-click (or run ./start.sh).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  read -r _; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
npm start
