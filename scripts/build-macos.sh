#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARCH=${1:-universal}

case "$ARCH" in
  universal)
    TARGET=universal-apple-darwin
    RUST_TARGETS=(x86_64-apple-darwin aarch64-apple-darwin)
    ;;
  arm64)
    TARGET=aarch64-apple-darwin
    RUST_TARGETS=(aarch64-apple-darwin)
    ;;
  x64|amd64)
    ARCH=x64
    TARGET=x86_64-apple-darwin
    RUST_TARGETS=(x86_64-apple-darwin)
    ;;
  *)
    echo "用法：$0 [universal|arm64|x64]" >&2
    exit 1
    ;;
esac

if [[ ! -x "$ROOT/desktop/node_modules/.bin/tauri" ]]; then
  npm --prefix "$ROOT/desktop" ci
fi

for target in "${RUST_TARGETS[@]}"; do
  rustup target add "$target" >/dev/null
done

if [[ "$ARCH" == "x64" ]]; then
  GO2RTC_ARCH=amd64
else
  GO2RTC_ARCH="$ARCH"
fi
"$ROOT/helpers/go2rtc/fetch.sh" "$GO2RTC_ARCH"

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  identity=$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F '"' '/Developer ID Application/ { print $2; exit }')
  if [[ -n "$identity" ]]; then
    export APPLE_SIGNING_IDENTITY="$identity"
  fi
fi

if [[ "${REQUIRE_SIGNED:-0}" == "1" && -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "REQUIRE_SIGNED=1，但没有找到 Developer ID Application 证书" >&2
  exit 1
fi

npm --prefix "$ROOT/desktop" run build -- --target "$TARGET"

VERSION=$(node -p "require('$ROOT/desktop/package.json').version")
SOURCE=$(find "$ROOT/desktop/src-tauri/target/$TARGET/release/bundle/dmg" \
  -maxdepth 1 -name '*.dmg' -print -quit)
if [[ -z "$SOURCE" ]]; then
  echo "没有找到 DMG 构建产物" >&2
  exit 1
fi

OUTPUT_DIR="$ROOT/dist/macos"
mkdir -p "$OUTPUT_DIR"
OUTPUT="$OUTPUT_DIR/MiHome-Mac-${VERSION}-${ARCH}.dmg"
cp "$SOURCE" "$OUTPUT"
(
  cd "$OUTPUT_DIR"
  shasum -a 256 "$(basename "$OUTPUT")" > "$(basename "$OUTPUT").sha256"
)

echo "DMG: $OUTPUT"
cat "$OUTPUT.sha256"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "签名身份：$APPLE_SIGNING_IDENTITY"
else
  echo "未发现 Developer ID Application 证书，产物为未签名版本。"
fi
