#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi
# Chromium is cached by Playwright; this is a no-op if it is already installed.
npx playwright install chromium >/dev/null
exec npm run collect -- "$@"
