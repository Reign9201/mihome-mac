#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ARCH=${1:-}
DEST=${2:-$ROOT}

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) echo "不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
  esac
fi

case "$ARCH" in
  amd64) ARCH=x64 ;;
esac

case "$ARCH" in
  arm64|x64|universal) ;;
  *) echo "用法：$0 [arm64|x64|universal] [目标目录]" >&2; exit 1 ;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/mihome-ffmpeg.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

build() {
  arch=$1
  "$ROOT/build-minimal.sh" "$arch" "$TMP/ffmpeg-$arch"
}

case "$ARCH" in
  arm64)
    build arm64
    source="$TMP/ffmpeg-arm64"
    ;;
  x64)
    build x64
    source="$TMP/ffmpeg-x64"
    ;;
  universal)
    build arm64
    build x64
    lipo -create "$TMP/ffmpeg-x64" "$TMP/ffmpeg-arm64" -output "$TMP/ffmpeg-universal"
    source="$TMP/ffmpeg-universal"
    ;;
esac

mkdir -p "$DEST"
install -m 755 "$source" "$DEST/ffmpeg"
case "$ARCH" in
  arm64)
    install -m 755 "$source" "$DEST/ffmpeg-aarch64-apple-darwin"
    ;;
  x64)
    install -m 755 "$source" "$DEST/ffmpeg-x86_64-apple-darwin"
    ;;
  universal)
    install -m 755 "$TMP/ffmpeg-arm64" "$DEST/ffmpeg-aarch64-apple-darwin"
    install -m 755 "$TMP/ffmpeg-x64" "$DEST/ffmpeg-x86_64-apple-darwin"
    install -m 755 "$TMP/ffmpeg-universal" "$DEST/ffmpeg-universal-apple-darwin"
    ;;
esac

echo "最小 FFmpeg 8.1.3 (${ARCH}) 已构建并安装到 $DEST"
