#!/usr/bin/env bash
# Record the golden frames, then prove they are deterministic.
#
#   tools/recapture-golden.sh              # into tests/golden
#   tools/recapture-golden.sh .tmp/g1      # anywhere else, for review first
#
# Two Chromium sessions on purpose: the first records, the second compares
# against what the first left behind. Sessions differ in wall clock, frame rate
# and rAF timing, so frames that agree across two of them are pinned to the seed
# rather than to the machine's mood -- and only that kind of frame is worth
# committing. Recording and comparing inside one process would prove nothing.
#
# Chromium needs escalation in this container (no user namespaces), which is why
# this lives in a script: it is one approval, and it runs both passes.
set -uo pipefail
cd "$(dirname "$0")/.."
GOLDEN_DIR="${1:-$PWD/tests/golden}"
export GOLDEN_DIR
mkdir -p "$GOLDEN_DIR" .tmp
status=0

echo "=== pass 1: record into $GOLDEN_DIR ==="
UPDATE_GOLDEN=1 bash tools/run-browser-check.sh > .tmp/golden-record.log 2>&1
echo "exit=$?"
tail -3 .tmp/golden-record.log
grep -E 'golden|FAIL' .tmp/golden-record.log || true

echo
echo "=== pass 2: compare a second session against the first ==="
bash tools/run-browser-check.sh > .tmp/golden-compare.log 2>&1
status=$?
tail -3 .tmp/golden-compare.log
grep -E 'golden|FAIL' .tmp/golden-compare.log || true

echo
if [ $status -eq 0 ]; then
  echo "PASS: two sessions agree; $(ls -1 "$GOLDEN_DIR" | tr '\n' ' ')"
else
  echo "FAIL: a frame did not reproduce (logs in .tmp/golden-*.log)"
fi
exit $status
