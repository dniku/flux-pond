# Discover the local JS/Python toolchain.
#
# Node, jsdom and pngjs exist on this host but are not on PATH and cannot be
# downloaded (no network), so they are located by store path. `tools/check.sh`
# fails with a clear message when Node is missing; the app itself needs nothing
# but a browser.
set -euo pipefail

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  ls -1 /nix/store/*node*/bin/node 2>/dev/null | sort -V | tail -1
}

# The directory holding this file's project, resolved even when the caller
# sourced it from elsewhere.
flux_pond_root() {
  dirname "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
}

# Directory holding a usable `node_modules/jsdom`, if any. The project's own
# `node_modules` wins -- that is what `npm install` fills and the only thing a
# CI runner has. The shared-host search below is for this container, where
# nothing can be installed; it is restricted to module roots and never reads the
# contents of unrelated project trees.
find_node_modules() {
  local candidate own
  own="$(flux_pond_root)/node_modules"
  if [ -d "$own/jsdom" ]; then
    echo "$own"
    return 0
  fi
  for candidate in /tmp/codex/*/source/node_modules /tmp/codex/*/node_modules; do
    if [ -d "$candidate/jsdom" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
