#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARCH=${1:-universal}
DMG_FORMAT=${DMG_FORMAT:-ULMO}

case "$DMG_FORMAT" in
  UDZO|UDBZ|ULFO|ULMO) ;;
  *)
    echo "不支持的 DMG_FORMAT：$DMG_FORMAT（可选 UDZO|UDBZ|ULFO|ULMO）" >&2
    exit 1
    ;;
esac

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

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  # macOS local-network TCC only applies reliably to a signed app bundle.
  # Use an ad-hoc signature for local/CI builds when no Developer ID exists.
  export APPLE_SIGNING_IDENTITY="-"
  SIGNING_MODE=ad-hoc
else
  SIGNING_MODE=developer-id
fi

npm --prefix "$ROOT/desktop" run build -- --target "$TARGET"

APP_BUNDLE=$(find "$ROOT/desktop/src-tauri/target/$TARGET/release/bundle/macos" \
  -maxdepth 1 -name '*.app' -print -quit)
if [[ -n "$APP_BUNDLE" ]]; then
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
fi

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
if [[ "$DMG_FORMAT" == "UDZO" ]]; then
  cp "$SOURCE" "$OUTPUT"
else
  hdiutil convert "$SOURCE" -format "$DMG_FORMAT" -ov -o "$OUTPUT" >/dev/null
fi

if [[ "$SIGNING_MODE" == "developer-id" ]]; then
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$OUTPUT"
fi

(
  cd "$OUTPUT_DIR"
  shasum -a 256 "$(basename "$OUTPUT")" > "$(basename "$OUTPUT").sha256"
)

echo "DMG: $OUTPUT"
echo "格式: $DMG_FORMAT"
du -h "$OUTPUT"
cat "$OUTPUT.sha256"
if [[ "$SIGNING_MODE" == "developer-id" ]]; then
  echo "Developer ID 签名：$APPLE_SIGNING_IDENTITY"
else
  echo "未发现 Developer ID Application 证书，产物使用 ad-hoc 签名。"
fi
