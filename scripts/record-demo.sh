#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/assets/demo.gif}"
OUT_DIR="$ROOT/docs"
CROP="1000:520:0:128"
SS=6
DUR=12

if [[ ! -f "$SRC" ]]; then
  echo "Source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
VF="crop=${CROP},fps=12,scale=1200:-1:flags=lanczos"

echo "→ docs/demo.gif"
ffmpeg -y -i "$SRC" -ss "$SS" -t "$DUR" \
  -vf "${VF},split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=2" \
  "$OUT_DIR/demo.gif"

echo "→ docs/demo.mp4"
ffmpeg -y -i "$SRC" -ss "$SS" -t "$DUR" \
  -vf "$VF" -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart \
  "$OUT_DIR/demo.mp4"

ls -lh "$OUT_DIR/demo.gif" "$OUT_DIR/demo.mp4"
