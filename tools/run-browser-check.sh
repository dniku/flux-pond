#!/usr/bin/env bash
# Run the headless-Chromium end-to-end check.
#
# Playwright and its Chromium come from the environment when there is one to
# take: `nix develop` exports `PLAYWRIGHT_ENTRY` and `PLAYWRIGHT_BROWSERS_PATH`
# for the pair pinned in flake.nix. Where nothing is exported -- a laptop that
# ran `npm install` plus `npx playwright install chromium` -- they stay unset and
# Playwright resolves its own browser. `--no-sandbox` is passed regardless,
# because this container gives Chromium no user namespace.
#
# Golden frames are compared against tests/golden; run with UPDATE_GOLDEN=1 to
# record the current frames there, GOLDEN_DIR to point them somewhere else.
set -euo pipefail
source "$(dirname "$0")/toolchain.sh"

NODE_BIN="$(find_node)"
mkdir -p .tmp/shots

# An empty variable is not the same as an absent one downstream: browser-check
# reads `PLAYWRIGHT_ENTRY=''` as a module id. So nothing is exported unless it
# was found, and an inherited value is never overwritten -- guessing on top of
# the flake's pinned Playwright would silently swap in whichever Chromium
# happened to sort last out of /nix/store.
if [ -z "${PLAYWRIGHT_ENTRY:-}" ]; then
  node_modules="$(find_node_modules || true)"
  if [ -n "$node_modules" ] && [ -f "$node_modules/playwright/index.js" ]; then
    export PLAYWRIGHT_ENTRY="$node_modules/playwright/index.js"
  fi
fi

if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  # <browsers>/chromium-1248/chrome-linux64/chrome: locate once, export both, so
  # the executable and the browser registry it came from cannot disagree.
  store_chrome="$(ls -1 /nix/store/*playwright-browsers*/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$store_chrome" ]; then
    export CHROMIUM_PATH="$store_chrome"
    export PLAYWRIGHT_BROWSERS_PATH="$(dirname "$(dirname "$(dirname "$store_chrome")")")"
  fi
fi

# Which browser painted these frames belongs in the log: the goldens are pixel
# comparisons, and a mismatch is worth much less triage without it.
echo "playwright: ${PLAYWRIGHT_ENTRY:-resolved by Playwright from its own package}"
if [ -n "${CHROMIUM_PATH:-}" ]; then
  echo "chromium:   $CHROMIUM_PATH"
else
  echo "chromium:   ${PLAYWRIGHT_BROWSERS_PATH:-resolved by Playwright from its own download}"
fi

"$NODE_BIN" tools/browser-check.mjs .tmp/shots
