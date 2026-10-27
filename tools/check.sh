#!/usr/bin/env bash
#
# The whole acceptance checklist, in one command.
#
#   tools/check.sh            syntax + unit/behavioural tests
#   tools/check.sh --browser  also run the headless-Chromium page check
#
# Node is found on PATH or in the Nix store (see tools/toolchain.sh). Everything
# is local: no network is used, and no dependency is downloaded.
set -uo pipefail
cd "$(dirname "$0")/.."
source tools/toolchain.sh

status=0
NODE_BIN="$(find_node)"

if [ -z "$NODE_BIN" ]; then
  echo "FAIL: no Node runtime found on PATH or in /nix/store." >&2
  echo "      All checks need Node; the app itself only needs a browser." >&2
  exit 1
fi
echo "node: $($NODE_BIN --version)"

echo
echo "== syntax (node --check) =="
for file in src/*.js tests/*.mjs tools/*.mjs; do
  if "$NODE_BIN" --check "$file" 2>/dev/null; then
    echo "  ok   $file"
  else
    echo "  FAIL $file"
    "$NODE_BIN" --check "$file" 2>&1 | sed 's/^/       /'
    status=1
  fi
done

echo
echo "== tests =="
for test_file in tests/*.test.mjs; do
  output="$("$NODE_BIN" "$test_file" 2>&1)"
  code=$?
  if [ $code -eq 0 ]; then
    summary="$(printf '%s' "$output" | tail -1)"
    if printf '%s' "$output" | grep -q '^SKIP'; then
      echo "  SKIP $test_file"
      printf '%s\n' "$output" | sed 's/^/       /'
    else
      echo "  ok   $test_file  $summary"
    fi
  else
    echo "  FAIL $test_file"
    printf '%s\n' "$output" | sed 's/^/       /'
    status=1
  fi
done

if [ "${1:-}" = "--browser" ]; then
  echo
  echo "== headless Chromium page check =="
  if bash tools/run-browser-check.sh; then
    echo "  ok   browser check"
  else
    echo "  FAIL browser check (screenshots in .tmp/shots)"
    status=1
  fi
fi

echo
if [ $status -eq 0 ]; then
  echo "PASS"
else
  echo "FAIL"
fi
exit $status
