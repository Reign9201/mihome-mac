#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$ROOT/build/voice"
VOICE="${MIHOME_DEMO_VOICE:-zh-CN-XiaoxiaoNeural}"
RATE="${MIHOME_DEMO_RATE:-+12%}"
PITCH="${MIHOME_DEMO_PITCH:-+2Hz}"

command -v uvx >/dev/null 2>&1 || {
  echo "uvx is required: https://docs.astral.sh/uv/" >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"

index=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  index=$((index + 1))
  output="$OUTPUT_DIR/line-$index.mp3"
  uvx edge-tts \
    --text "$line" \
    --voice "$VOICE" \
    --rate="$RATE" \
    --pitch="$PITCH" \
    --write-media "$output" \
    --no-progress
  printf 'generated %s\n' "$output"
done < "$ROOT/voiceover.txt"

echo "generated $index voiceover lines"
