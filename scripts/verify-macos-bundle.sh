#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DMG=${1:-}
EXPECTED_ARCH=${2:-}
APP_NAME="MiHome Mac"

if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  echo "用法：$0 <DMG> [universal|arm64|x64]" >&2
  exit 1
fi

SHA_FILE="$DMG.sha256"
if [[ -f "$SHA_FILE" ]]; then
  DMG_NAME=$(basename "$DMG")
  EXPECTED_SHA=$(awk -v name="$DMG_NAME" \
    '$2 == name || $2 == "*" name { print $1; exit }' "$SHA_FILE")
  ACTUAL_SHA=$(shasum -a 256 "$DMG" | awk '{ print $1 }')
  if [[ ${#EXPECTED_SHA} -ne 64 || "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
    echo "DMG SHA256 校验失败：$DMG" >&2
    echo "expected: ${EXPECTED_SHA:-<missing>}" >&2
    echo "actual:   $ACTUAL_SHA" >&2
    exit 1
  fi
fi

MOUNT=$(mktemp -d "${TMPDIR:-/tmp}/mihome-dmg.XXXXXX")
cleanup() {
  hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  rmdir "$MOUNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null
APP="$MOUNT/$APP_NAME.app"
EXEC="$APP/Contents/MacOS/mihome-mac"
SIDECAR="$APP/Contents/MacOS/go2rtc"

[[ -d "$APP" ]] || { echo "应用不存在：$APP" >&2; exit 1; }
[[ -x "$EXEC" ]] || { echo "主程序不存在或不可执行：$EXEC" >&2; exit 1; }
[[ -x "$SIDECAR" ]] || { echo "go2rtc sidecar 不存在：$SIDECAR" >&2; exit 1; }
[[ -f "$APP/Contents/Resources/LICENSE" ]] || { echo "缺少 LICENSE" >&2; exit 1; }
[[ -f "$APP/Contents/Resources/THIRD_PARTY_NOTICES.md" ]] || {
  echo "缺少 THIRD_PARTY_NOTICES.md" >&2
  exit 1
}
[[ -f "$APP/Contents/Resources/go2rtc-LICENSE" ]] || {
  echo "缺少 go2rtc-LICENSE" >&2
  exit 1
}
LOCAL_NETWORK_USAGE=$(plutil -extract NSLocalNetworkUsageDescription raw \
  "$APP/Contents/Info.plist" 2>/dev/null || true)
[[ -n "$LOCAL_NETWORK_USAGE" ]] || {
  echo "Info.plist 缺少 NSLocalNetworkUsageDescription" >&2
  exit 1
}

ARCHS=$(lipo -archs "$EXEC")
SIDECAR_ARCHS=$(lipo -archs "$SIDECAR")
case "$EXPECTED_ARCH" in
  universal)
    [[ "$ARCHS" == *x86_64* && "$ARCHS" == *arm64* ]] || {
      echo "期望 universal，实际架构：$ARCHS" >&2
      exit 1
    }
    [[ "$SIDECAR_ARCHS" == *x86_64* && "$SIDECAR_ARCHS" == *arm64* ]] || {
      echo "go2rtc 期望 universal，实际架构：$SIDECAR_ARCHS" >&2
      exit 1
    }
    ;;
  arm64)
    [[ "$ARCHS" == *arm64* ]] || { echo "期望 arm64，实际架构：$ARCHS" >&2; exit 1; }
    [[ "$SIDECAR_ARCHS" == "arm64" ]] || {
      echo "go2rtc 期望 arm64，实际架构：$SIDECAR_ARCHS" >&2
      exit 1
    }
    ;;
  x64|amd64)
    [[ "$ARCHS" == *x86_64* ]] || { echo "期望 x86_64，实际架构：$ARCHS" >&2; exit 1; }
    [[ "$SIDECAR_ARCHS" == "x86_64" ]] || {
      echo "go2rtc 期望 x86_64，实际架构：$SIDECAR_ARCHS" >&2
      exit 1
    }
    ;;
esac

SIDECAR_HASH=$(shasum -a 256 "$SIDECAR" | awk '{ print $1 }')
SIDECAR_HASH_KNOWN=0
if awk -v hash="$SIDECAR_HASH" '$1 == "binary" && $3 == hash { found = 1 } END { exit !found }' \
  "$ROOT/helpers/go2rtc/checksums.txt"; then
  SIDECAR_HASH_KNOWN=1
fi

echo "DMG: $DMG"
echo "主程序架构: $ARCHS"
echo "go2rtc 架构: $SIDECAR_ARCHS"
echo "go2rtc SHA256: $SIDECAR_HASH"
if [[ -f "$SHA_FILE" ]]; then
  echo "DMG SHA256: $ACTUAL_SHA"
fi

SIGNED_OK=0
if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  SIGNED_OK=1
  codesign --verify --deep --strict --verbose=2 "$APP"
  codesign --verify --strict --verbose=2 "$SIDECAR"
  SIGNATURE_DETAILS=$(codesign -dv --verbose=4 "$APP" 2>&1 || true)
  if printf '%s\n' "$SIGNATURE_DETAILS" | grep -q "Authority=Developer ID Application"; then
    spctl --assess --type execute --verbose=4 "$APP"
    echo "Developer ID 签名与 Gatekeeper 校验通过"
  elif printf '%s\n' "$SIGNATURE_DETAILS" | grep -q "Signature=adhoc"; then
    echo "ad-hoc 签名校验通过；未经公证，Gatekeeper 分发校验跳过。"
  else
    echo "应用签名有效，但未检测到 Developer ID Application 或 ad-hoc 标记。" >&2
    exit 1
  fi
elif [[ "${REQUIRE_SIGNED:-0}" == "1" ]]; then
  echo "REQUIRE_SIGNED=1，但应用未签名" >&2
  exit 1
else
  echo "应用未签名；DMG 结构和资源校验通过，Gatekeeper 分发校验跳过。"
fi

if [[ "$SIDECAR_HASH_KNOWN" != "1" ]]; then
  if [[ "$SIGNED_OK" == "1" ]]; then
    echo "go2rtc 经应用包代码签名封装；上游 SHA256 因签名写回而变化。"
  else
    echo "go2rtc 哈希不在固定版本清单中：$SIDECAR_HASH" >&2
    exit 1
  fi
fi
