#!/usr/bin/env bash
set -euo pipefail

SRC_ICON="src/renderer/public/logo.png"
OUT_DIR="build"
ICONSET_DIR="$OUT_DIR/icon.iconset"
ICNS_PATH="$OUT_DIR/icon.icns"

if [[ ! -f "$SRC_ICON" ]]; then
  echo "Source icon not found: $SRC_ICON" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
  echo "sips/iconutil not found. Please run on macOS." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC_ICON" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  retina_size=$((size * 2))
  sips -z "$retina_size" "$retina_size" "$SRC_ICON" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"
rm -rf "$ICONSET_DIR"

echo "Generated: $ICNS_PATH"
