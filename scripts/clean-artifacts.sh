#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APPLY=0
BUILD=0
DIST_TEMP=0
FFMPEG_CACHE=0
FFMPEG_SOURCES=0
LOGS=0
LOG_KEEP_DAYS=14
TEMP_AGE_MINUTES=60
RECLAIMED_KB=0

usage() {
  cat <<'EOF'
用法：scripts/clean-artifacts.sh [选项]

默认只清理测试截图、i18n 缓存和项目产生的临时文件；默认是 dry-run。

选项：
  --apply                 实际删除；不加时只显示将删除的内容
  --build                 同时清理 Rust target 和旧的 dist/macos-regression
  --dist-temp             只清理 dist/macos-regression
  --ffmpeg-cache          清理 FFmpeg 旧 recipe 的 artifacts/builds 缓存
  --ffmpeg-sources        清理 FFmpeg 下载包和解压源码缓存
  --logs                  清理超过保留天数的 MiHome 日志
  --log-days N            日志保留天数，默认 14
  --temp-age-minutes N    只清理超过 N 分钟的临时文件，默认 60
  --help                  显示本帮助

不会删除：
  - 源码、.git、应用配置、米家账号与凭据
  - MiHome/models、MiHome/tools
  - dist/macos 中已发布的 DMG/SHA256
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --build) BUILD=1; DIST_TEMP=1 ;;
    --dist-temp) DIST_TEMP=1 ;;
    --ffmpeg-cache) FFMPEG_CACHE=1 ;;
    --ffmpeg-sources) FFMPEG_SOURCES=1 ;;
    --logs) LOGS=1 ;;
    --log-days)
      shift
      [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]] || {
        echo "--log-days 需要正整数" >&2
        exit 2
      }
      LOG_KEEP_DAYS=$1
      ;;
    --temp-age-minutes)
      shift
      [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]] || {
        echo "--temp-age-minutes 需要非负整数" >&2
        exit 2
      }
      TEMP_AGE_MINUTES=$1
      ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "未知选项：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

path_kb() {
  du -sk "$1" 2>/dev/null | awk '{ print $1 }' || true
}

remove_path() {
  local path=$1
  [[ -e "$path" || -L "$path" ]] || return 0
  local kb
  kb=$(path_kb "$path")
  RECLAIMED_KB=$((RECLAIMED_KB + ${kb:-0}))
  if [[ "$APPLY" -eq 1 ]]; then
    rm -rf -- "$path"
    printf '已删除  %s\n' "$path"
  else
    printf '将删除  %s\n' "$path"
  fi
}

remove_project_path() {
  local path=$1
  case "$path" in
    "$ROOT"/*) remove_path "$path" ;;
    *) echo "拒绝删除项目外路径：$path" >&2; exit 1 ;;
  esac
}

remove_temp_matches() {
  local tmp=${TMPDIR:-/tmp}
  local path
  while IFS= read -r -d '' path; do
    case "$(basename "$path")" in
      mihome-*) remove_path "$path" ;;
    esac
  done < <(
    find "$tmp" -maxdepth 1 -mmin "+$TEMP_AGE_MINUTES" \( \
      -name 'mihome-ui-*' -o \
      -name 'mihome-home-*.json' -o \
      -name 'mihome-gateway-*.json' -o \
      -name 'mihome-secrets-*.json' -o \
      -name 'mihome-pair-*.json' -o \
      -name 'mihome-llm-toggle-*.json' -o \
      -name 'mihome-ffmpeg-*' -o \
      -name 'mihome-adhoc-app.*' -o \
      -name 'mihome-asr-*' \
    \) -print0 2>/dev/null
  )
}

remove_stale_ffmpeg_cache() {
  local cache=${MIHOME_FFMPEG_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/Library/Caches}/mihome-mac/ffmpeg}
  local recipe
  recipe=$(shasum -a 256 "$ROOT/helpers/ffmpeg/build-minimal.sh" | awk '{ print $1 }')

  for group in artifacts builds; do
    [[ -d "$cache/$group" ]] || continue
    while IFS= read -r -d '' path; do
      [[ "$(basename "$path")" == "$recipe" ]] || remove_path "$path"
    done < <(find "$cache/$group" -mindepth 1 -maxdepth 1 -type d -print0)
  done
}

echo "项目：$ROOT"
echo "模式：$([[ "$APPLY" -eq 1 ]] && echo 实际删除 || echo dry-run)"

remove_project_path "$ROOT/desktop/tests/artifacts"
remove_project_path "$ROOT/desktop/.i18n-cache.json"
remove_temp_matches

if [[ "$BUILD" -eq 1 ]]; then
  remove_project_path "$ROOT/core/target"
  remove_project_path "$ROOT/desktop/src-tauri/target"
fi

if [[ "$DIST_TEMP" -eq 1 ]]; then
  remove_project_path "$ROOT/dist/macos-regression"
fi

if [[ "$FFMPEG_CACHE" -eq 1 ]]; then
  remove_stale_ffmpeg_cache
fi

if [[ "$FFMPEG_SOURCES" -eq 1 ]]; then
  cache=${MIHOME_FFMPEG_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/Library/Caches}/mihome-mac/ffmpeg}
  remove_path "$cache/downloads"
  remove_path "$cache/src"
fi

if [[ "$LOGS" -eq 1 ]]; then
  log_dir="$HOME/Library/Logs/MiHome"
  if [[ -d "$log_dir" ]]; then
    while IFS= read -r -d '' path; do
      remove_path "$path"
    done < <(find "$log_dir" -maxdepth 1 -type f -name 'log-*.log' -mtime "+$LOG_KEEP_DAYS" -print0)
  fi
fi

human_kb() {
  awk -v kb="$RECLAIMED_KB" 'BEGIN {
    if (kb >= 1048576) printf "%.2f GB", kb / 1048576;
    else if (kb >= 1024) printf "%.1f MB", kb / 1024;
    else printf "%.0f KB", kb;
  }'
}

printf '\n可回收空间：%s\n' "$(human_kb)"
if [[ "$APPLY" -eq 0 ]]; then
  echo "确认无误后追加 --apply 执行删除。"
fi
