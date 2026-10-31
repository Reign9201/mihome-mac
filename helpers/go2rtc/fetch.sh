#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CHECKSUMS="$ROOT/checksums.txt"
VERSION=1.9.15
ARCH=${1:-}
DEST=${2:-$ROOT}

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=amd64 ;;
    *) echo "不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
  esac
fi

case "$ARCH" in
  arm64|amd64|universal) ;;
  *) echo "用法：$0 [arm64|amd64|universal] [目标目录]" >&2; exit 1 ;;
esac

checksum() {
  awk -v kind="$1" -v arch="$2" '$1 == kind && $2 == arch { print $3 }' "$CHECKSUMS"
}

verify() {
  expected=$1
  file=$2
  actual=$(shasum -a 256 "$file" | awk '{ print $1 }')
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    echo "SHA256 校验失败：$file" >&2
    echo "expected: ${expected:-<missing>}" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/mihome-go2rtc.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

download() {
  asset=$1
  asset_arch=${asset#go2rtc_mac_}
  asset_arch=${asset_arch%.zip}
  url="https://github.com/AlexxIT/go2rtc/releases/download/v${VERSION}/${asset}"
  curl -fsSL --retry 3 --retry-delay 2 -o "$TMP/$asset" "$url"
  verify "$(checksum archive "$asset_arch")" "$TMP/$asset"
  unzip -p "$TMP/$asset" go2rtc > "$TMP/${asset%.zip}"
}

case "$ARCH" in
  arm64)
    download go2rtc_mac_arm64.zip
    source="$TMP/go2rtc_mac_arm64"
    verify "$(checksum binary arm64)" "$source"
    ;;
  amd64)
    download go2rtc_mac_amd64.zip
    source="$TMP/go2rtc_mac_amd64"
    verify "$(checksum binary amd64)" "$source"
    ;;
  universal)
    download go2rtc_mac_arm64.zip
    download go2rtc_mac_amd64.zip
    verify "$(checksum binary arm64)" "$TMP/go2rtc_mac_arm64"
    verify "$(checksum binary amd64)" "$TMP/go2rtc_mac_amd64"
    lipo -create "$TMP/go2rtc_mac_amd64" "$TMP/go2rtc_mac_arm64" -output "$TMP/go2rtc_universal"
    source="$TMP/go2rtc_universal"
    verify "$(checksum binary universal)" "$source"
    ;;
esac

mkdir -p "$DEST"
install -m 755 "$source" "$DEST/go2rtc"
case "$ARCH" in
  arm64)
    install -m 755 "$source" "$DEST/go2rtc-aarch64-apple-darwin"
    ;;
  amd64)
    install -m 755 "$source" "$DEST/go2rtc-x86_64-apple-darwin"
    ;;
  universal)
    install -m 755 "$source" "$DEST/go2rtc-aarch64-apple-darwin"
    install -m 755 "$source" "$DEST/go2rtc-x86_64-apple-darwin"
    install -m 755 "$source" "$DEST/go2rtc-universal-apple-darwin"
    ;;
esac

echo "go2rtc ${VERSION} (${ARCH}) 已校验并安装到 $DEST"
