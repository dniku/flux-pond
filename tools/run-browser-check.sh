#!/usr/bin/env bash
# Run the headless-Chromium end-to-end check.
#
# Browsers are not downloadable here (no network), so Playwright is pointed at
# the copies already in the Nix store. `--no-sandbox` is required because this
# container cannot create user namespaces for Chromium's own sandbox.
#
# Golden frames are compared against tests/golden; run with UPDATE_GOLDEN=1 to
# record the current frames there, GOLDEN_DIR to point them somewhere else.
set -euo pipefail
source "$(dirname "$0")/toolchain.sh"

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/nix/store/4z4armxix616z1ca9vhslwqx23icpn2c-playwright-browsers}"
NODE_MODULES="$(find_node_modules)"
NODE_BIN="$(find_node)"
mkdir -p .tmp/shots

CHROMIUM_PATH="${CHROMIUM_PATH:-$(ls -1 /nix/store/*playwright-browsers/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)}"
export CHROMIUM_PATH
PLAYWRIGHT_ENTRY="$NODE_MODULES/playwright/index.js" "$NODE_BIN" tools/browser-check.mjs .tmp/shots
