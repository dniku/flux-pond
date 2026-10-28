#!/usr/bin/env bash
#
# Regenerate the one image the README carries that is not already a golden frame.
#
#   tools/readme-graphics.sh
#
# The README links the pinned frames in tests/golden directly rather than keeping
# a second copy of the same pixels in the repo. The exception is the lurker: in
# the full 1024x640 frame it is a third of the width and reads as a smudge once
# GitHub scales it down, so it is published once more, cut out and doubled.
#
# ffmpeg because this host has neither ImageMagick nor Pillow. Run this after
# tools/recapture-golden.sh if the crop window below ever stops matching the
# animal's position (it is a fixed window: the frame is deterministic, so a crop
# of a frame that moved is a crop of the wrong thing).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p docs

# Measured off the 1024x640 frame: the whole animal -- dorsal, tail, eye -- and
# none of the status panel (right edge x=228) or the hint panel (top edge y=448).
ffmpeg -y -v error -i tests/golden/idle-5s.png \
  -vf "crop=470:172:235:270,scale=940:344:flags=lanczos" \
  docs/lurker-near.png

ls -l docs/lurker-near.png
