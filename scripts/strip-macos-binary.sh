#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TRIPLE=${TAURI_ENV_TARGET_TRIPLE:-}

if [[ -z "$TRIPLE" ]]; then
  echo "缺少 TAURI_ENV_TARGET_TRIPLE，无法定位待裁剪的主程序" >&2
  exit 1
fi

BIN="$ROOT/desktop/src-tauri/target/$TRIPLE/release/mihome-mac"
if [[ ! -f "$BIN" ]]; then
  echo "主程序不存在：$BIN" >&2
  exit 1
fi

before=$(stat -f %z "$BIN")
/usr/bin/strip -x "$BIN"
after=$(stat -f %z "$BIN")

case "$TRIPLE" in
  aarch64-apple-darwin)
    [[ "$(lipo -archs "$BIN")" == "arm64" ]] || {
      echo "裁剪后架构异常：$(lipo -archs "$BIN")" >&2
      exit 1
    }
    ;;
  x86_64-apple-darwin)
    [[ "$(lipo -archs "$BIN")" == "x86_64" ]] || {
      echo "裁剪后架构异常：$(lipo -archs "$BIN")" >&2
      exit 1
    }
    ;;
  universal-apple-darwin)
    ARCHS=$(lipo -archs "$BIN")
    [[ "$ARCHS" == *x86_64* && "$ARCHS" == *arm64* ]] || {
      echo "裁剪后架构异常：$ARCHS" >&2
      exit 1
    }
    ;;
  *)
    echo "不支持的 Tauri target：$TRIPLE" >&2
    exit 1
    ;;
esac

echo "主程序符号裁剪：$before -> $after bytes"
