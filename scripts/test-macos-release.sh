#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP_NAME="MiHome Mac"
EXEC_NAME="mihome-mac"
TAG="v1.3.0"
VERSION="1.3.0"
ARCH=""
ROUNDS=10
DMG=""
OUTPUT_DIR=""
TIMEOUT_SECONDS=120
EXPECTED_FFMPEG="8.1.3"
EXPECTED_SHA=""
KEEP_ROUND_DATA=0

CURRENT_MOUNT=""
CURRENT_PID=""

usage() {
  cat <<'EOF'
Usage: scripts/test-macos-release.sh [options]

Options:
  --arch arm64|x64       Test architecture (default: host architecture)
  --tag v1.3.0           Release tag used for download and version checks
  --version 1.3.0        Expected app version (default: tag without leading v)
  --rounds 10            Number of isolated install/start rounds
  --dmg PATH             Use an existing DMG instead of downloading the Release
  --sha256 HEX           Expected DMG SHA256 (also read from PATH.sha256)
  --output DIR           Evidence directory
  --timeout 120          Seconds to wait for startup and QR generation
  --ffmpeg-version 8.1.3 Expected bundled FFmpeg version
  --keep                 Keep each round's HOME, TMPDIR and copied app
  -h, --help             Show this help
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000'
}

json_escape() {
  printf '%s' "$1" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

terminate_current() {
  if [[ -n "$CURRENT_PID" ]] && kill -0 "$CURRENT_PID" >/dev/null 2>&1; then
    kill -TERM "$CURRENT_PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do
      kill -0 "$CURRENT_PID" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -KILL "$CURRENT_PID" >/dev/null 2>&1 || true
  fi
  CURRENT_PID=""
}

cleanup() {
  terminate_current
  if [[ -n "$CURRENT_MOUNT" ]]; then
    hdiutil detach "$CURRENT_MOUNT" >/dev/null 2>&1 || true
    rmdir "$CURRENT_MOUNT" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      ARCH=${2:-}
      shift 2
      ;;
    --tag)
      TAG=${2:-}
      shift 2
      ;;
    --version)
      VERSION=${2:-}
      shift 2
      ;;
    --rounds)
      ROUNDS=${2:-}
      shift 2
      ;;
    --dmg)
      DMG=${2:-}
      shift 2
      ;;
    --sha256)
      EXPECTED_SHA=${2:-}
      shift 2
      ;;
    --output)
      OUTPUT_DIR=${2:-}
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS=${2:-}
      shift 2
      ;;
    --ffmpeg-version)
      EXPECTED_FFMPEG=${2:-}
      shift 2
      ;;
    --keep)
      KEEP_ROUND_DATA=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) die "unsupported host architecture: $(uname -m)" ;;
  esac
fi

case "$ARCH" in
  arm64)
    MACHO_ARCH=arm64
    ;;
  x64|amd64)
    ARCH=x64
    MACHO_ARCH=x86_64
    ;;
  *)
    die "--arch must be arm64 or x64"
    ;;
esac

[[ "$ROUNDS" =~ ^[1-9][0-9]*$ ]] || die "--rounds must be a positive integer"
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "--timeout must be a positive integer"
[[ -n "$VERSION" ]] || VERSION=${TAG#v}

STAMP=$(date +%Y%m%d-%H%M%S)
if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$ROOT/dist/macos-regression/${TAG}-${ARCH}-${STAMP}"
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)

DOWNLOAD_DIR="$OUTPUT_DIR/download"
mkdir -p "$DOWNLOAD_DIR"

if [[ -z "$DMG" ]]; then
  ASSET="MiHome-Mac-${VERSION}-${ARCH}.dmg"
  BASE_URL="https://github.com/Reign9201/mihome-mac/releases/download/${TAG}"
  DMG="$DOWNLOAD_DIR/$ASSET"
  SHA_FILE="$DMG.sha256"
  echo "Downloading $BASE_URL/$ASSET"
  curl --fail --location --retry 3 --retry-delay 2 \
    --output "$DMG" "$BASE_URL/$ASSET"
  curl --fail --location --retry 3 --retry-delay 2 \
    --output "$SHA_FILE" "$BASE_URL/$ASSET.sha256"
else
  DMG=$(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")
  [[ -f "$DMG" ]] || die "DMG not found: $DMG"
  SHA_FILE="$DMG.sha256"
fi

if [[ -f "$SHA_FILE" ]]; then
  FILE_SHA=$(awk 'NR == 1 { print $1 }' "$SHA_FILE")
  if [[ -z "$EXPECTED_SHA" ]]; then
    EXPECTED_SHA="$FILE_SHA"
  elif [[ "$EXPECTED_SHA" != "$FILE_SHA" ]]; then
    die "provided SHA256 does not match $SHA_FILE"
  fi
fi

ACTUAL_SHA=$(shasum -a 256 "$DMG" | awk '{ print $1 }')
if [[ -n "$EXPECTED_SHA" && "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  die "DMG SHA256 mismatch: expected $EXPECTED_SHA, got $ACTUAL_SHA"
fi

echo "Tag:          $TAG"
echo "Version:      $VERSION"
echo "Architecture: $ARCH"
echo "Host:         $(uname -m) $(sw_vers -productVersion)"
echo "Rounds:       $ROUNDS"
echo "DMG:          $DMG"
echo "SHA256:       $ACTUAL_SHA"
echo "Evidence:     $OUTPUT_DIR"

"$ROOT/scripts/verify-macos-bundle.sh" "$DMG" "$ARCH" \
  >"$OUTPUT_DIR/bundle-verify.log" 2>&1

write_round_json() {
  local round=$1
  local result=$2
  local round_dir=$3
  local round_error
  round_error=$(json_escape "$ROUND_ERROR")
  cat >"$round_dir/result.json" <<EOF
{"round":$round,"result":"$result","startupMs":${STARTUP_MS:-0},"exitStatus":${APP_EXIT:-0},"ffmpegVersion":"$(json_escape "$FFMPEG_VERSION")","architecture":"$(json_escape "$ACTUAL_ARCHS")","dependencies":"$(json_escape "$DEPENDENCY_STATUS")","qrGenerated":${QR_GENERATED:-0},"residualProcesses":${RESIDUAL_COUNT:-0},"error":"$round_error"}
EOF
}

set_round_error() {
  local round=$1
  shift
  ROUND_ERROR="$*"
  printf '%s\n' "$ROUND_ERROR" >"$ROUND_DIR/error.txt"
  echo "Round $round failed: $ROUND_ERROR" >&2
  return 1
}

validate_binary_arch() {
  local binary=$1
  local label=$2
  [[ -f "$binary" ]] || {
    ROUND_ERROR="$label is missing: $binary"
    return 1
  }
  lipo "$binary" -verify_arch "$MACHO_ARCH" >/dev/null 2>&1 || {
    ROUND_ERROR="$label does not contain $MACHO_ARCH"
    return 1
  }
}

validate_system_dependencies() {
  local binary
  local dependency
  local bad
  for binary in "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME" \
    "$APP_BUNDLE/Contents/MacOS/go2rtc" \
    "$APP_BUNDLE/Contents/MacOS/ffmpeg"; do
    bad=$(
      otool -L "$binary" | tail -n +2 | awk '{ print $1 }' |
        grep -Ev '^(/usr/lib/|/System/Library/)' || true
    )
    if [[ -n "$bad" ]]; then
      ROUND_ERROR="non-system dependency in $(basename "$binary"): $bad"
      return 1
    fi
  done
  DEPENDENCY_STATUS="system-only"
}

validate_app() {
  local info_plist="$APP_BUNDLE/Contents/Info.plist"
  local app_version

  validate_binary_arch "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME" "main executable" ||
    return 1
  validate_binary_arch "$APP_BUNDLE/Contents/MacOS/go2rtc" "go2rtc" || return 1
  validate_binary_arch "$APP_BUNDLE/Contents/MacOS/ffmpeg" "ffmpeg" || return 1

  app_version=$(plutil -extract CFBundleShortVersionString raw "$info_plist" 2>/dev/null || true)
  [[ "$app_version" == "$VERSION" ]] || {
    ROUND_ERROR="app version is '$app_version', expected '$VERSION'"
    return 1
  }

  if ! codesign --verify --deep --strict "$APP_BUNDLE" >/dev/null 2>&1; then
    if [[ "${REQUIRE_SIGNED:-0}" == "1" ]]; then
      ROUND_ERROR="copied app bundle signature verification failed"
      return 1
    fi
    echo "  app is unsigned; signature check skipped (set REQUIRE_SIGNED=1 to enforce)"
  fi

  for resource in LICENSE THIRD_PARTY_NOTICES.md go2rtc-LICENSE ffmpeg-LICENSE \
    ffmpeg-COPYING.GPLv3 ffmpeg-x264-COPYING ffmpeg-opus-COPYING; do
    [[ -f "$APP_BUNDLE/Contents/Resources/$resource" ]] || {
      ROUND_ERROR="missing bundle resource: $resource"
      return 1
    }
  done

  FFMPEG="$APP_BUNDLE/Contents/MacOS/ffmpeg"
  FFMPEG_VERSION=$("$FFMPEG" -hide_banner -version 2>&1 | sed -n '1p') || {
    ROUND_ERROR="bundled ffmpeg could not run"
    return 1
  }
  [[ "$FFMPEG_VERSION" == *"$EXPECTED_FFMPEG"* ]] || {
    ROUND_ERROR="ffmpeg version is '$FFMPEG_VERSION', expected $EXPECTED_FFMPEG"
    return 1
  }

  local encoders
  local decoders
  local demuxers
  local muxers
  local filters
  encoders=$("$FFMPEG" -hide_banner -encoders 2>/dev/null)
  decoders=$("$FFMPEG" -hide_banner -decoders 2>/dev/null)
  demuxers=$("$FFMPEG" -hide_banner -demuxers 2>/dev/null)
  muxers=$("$FFMPEG" -hide_banner -muxers 2>/dev/null)
  filters=$("$FFMPEG" -hide_banner -filters 2>/dev/null)

  for encoder in libx264 h264_videotoolbox libopus pcm_alaw pcm_s16le; do
    printf '%s\n' "$encoders" |
      grep -Eq "^[[:space:]]*[VAS][A-Z.]{5}[[:space:]]+${encoder}([[:space:]]|$)" || {
        ROUND_ERROR="ffmpeg encoder missing: $encoder"
        return 1
      }
  done
  for decoder in h264 hevc opus; do
    printf '%s\n' "$decoders" |
      grep -Eq "^[[:space:]]*[VAS][A-Z.]{5}[[:space:]]+${decoder}([[:space:]]|$)" || {
        ROUND_ERROR="ffmpeg decoder missing: $decoder"
        return 1
      }
  done
  for muxer in rtsp wav; do
    printf '%s\n' "$muxers" |
      grep -Eq "^[[:space:]]*E[[:space:]]+${muxer}([[:space:]]|$)" || {
        ROUND_ERROR="ffmpeg muxer missing: $muxer"
        return 1
      }
  done
  printf '%s\n' "$demuxers" |
    grep -Eq '^[[:space:]]*D[[:space:]]+ogg([[:space:]]|$)' || {
      ROUND_ERROR="ffmpeg Ogg demuxer is missing"
      return 1
    }
  for filter in scale fps aresample format; do
    printf '%s\n' "$filters" |
      grep -Eq "[[:space:]]${filter}[[:space:]]" || {
        ROUND_ERROR="ffmpeg filter missing: $filter"
        return 1
      }
  done

  validate_system_dependencies || return 1
  ACTUAL_ARCHS=$(lipo -archs "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME")
}

run_round() {
  local round=$1
  local padded
  padded=$(printf '%02d' "$round")
  ROUND_DIR="$OUTPUT_DIR/round-$padded"
  local apps_dir="$ROUND_DIR/Applications"
  local home_dir="$ROUND_DIR/home"
  local tmp_dir="$ROUND_DIR/tmp"
  local logs_dir="$ROUND_DIR/logs"
  local diagnostics_dir="$ROUND_DIR/diagnostics"
  local mount_dir="$ROUND_DIR/mount"
  local stdout_log="$ROUND_DIR/stdout.log"
  local stderr_log="$ROUND_DIR/stderr.log"

  mkdir -p "$apps_dir" "$home_dir" "$tmp_dir" "$logs_dir" "$diagnostics_dir" "$mount_dir"
  chmod 700 "$home_dir" "$tmp_dir" "$logs_dir" "$diagnostics_dir"

  ROUND_ERROR=""
  STARTUP_MS=0
  APP_EXIT=0
  FFMPEG_VERSION=""
  ACTUAL_ARCHS=""
  DEPENDENCY_STATUS=""
  QR_GENERATED=0
  RESIDUAL_COUNT=0

  echo
  echo "=== Round $round/$ROUNDS ==="
  CURRENT_MOUNT="$mount_dir"
  if ! hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$DMG" >/dev/null; then
    set_round_error "$round" "failed to mount DMG"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  if [[ ! -d "$mount_dir/$APP_NAME.app" ]]; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
    CURRENT_MOUNT=""
    set_round_error "$round" "DMG does not contain $APP_NAME.app"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  if ! /usr/bin/ditto "$mount_dir/$APP_NAME.app" "$apps_dir/$APP_NAME.app"; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
    CURRENT_MOUNT=""
    set_round_error "$round" "failed to copy app bundle"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
  CURRENT_MOUNT=""

  APP_BUNDLE="$apps_dir/$APP_NAME.app"
  if ! validate_app; then
    set_round_error "$round" "$ROUND_ERROR"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  local exec_path="$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"
  START_MS=$(now_ms)
  local original_dir=$PWD
  cd "$home_dir"
  env \
    HOME="$home_dir" \
    TMPDIR="$tmp_dir/" \
    PATH="/usr/bin:/bin" \
    MIHOME_LOG_DIR="$logs_dir" \
    MIHOME_DIAGNOSTICS_DIR="$diagnostics_dir" \
    "$exec_path" >"$stdout_log" 2>"$stderr_log" &
  APP_PID=$!
  cd "$original_dir"
  echo "$APP_PID" >"$ROUND_DIR/pid"
  CURRENT_PID="$APP_PID"

  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while true; do
    if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
      APP_EXIT=0
      wait "$APP_PID" 2>/dev/null || APP_EXIT=$?
      CURRENT_PID=""
      set_round_error "$round" "app exited before QR generation (status $APP_EXIT)"
      write_round_json "$round" "fail" "$ROUND_DIR"
      return 1
    fi
    if grep -Rqs '登录二维码已生成' "$logs_dir"; then
      QR_GENERATED=1
      break
    fi
    if grep -Rqs '申请登录二维码失败' "$logs_dir"; then
      set_round_error "$round" "QR request failed; see logs"
      terminate_current
      write_round_json "$round" "fail" "$ROUND_DIR"
      return 1
    fi
    if [[ "$SECONDS" -ge "$deadline" ]]; then
      set_round_error "$round" "timed out waiting for QR generation"
      terminate_current
      write_round_json "$round" "fail" "$ROUND_DIR"
      return 1
    fi
    sleep 0.25
  done
  STARTUP_MS=$(( $(now_ms) - START_MS ))

  sleep 1
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    APP_EXIT=0
    wait "$APP_PID" 2>/dev/null || APP_EXIT=$?
    CURRENT_PID=""
    set_round_error "$round" "app exited after QR generation (status $APP_EXIT)"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  kill -TERM "$APP_PID"
  APP_EXIT=0
  local exited=0
  for _ in $(seq 1 150); do
    if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
      wait "$APP_PID" 2>/dev/null || APP_EXIT=$?
      exited=1
      break
    fi
    sleep 0.1
  done
  CURRENT_PID=""
  if [[ "$exited" != "1" ]]; then
    kill -KILL "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" 2>/dev/null || APP_EXIT=$?
    set_round_error "$round" "app did not stop within 15 seconds"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi
  if [[ "$APP_EXIT" != "0" && "$APP_EXIT" != "143" ]]; then
    set_round_error "$round" "unexpected app exit status: $APP_EXIT"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  local residual
  residual=$(
    ps -axo pid=,command= |
      grep -F "$APP_BUNDLE/Contents/MacOS/" |
      grep -v '[g]rep' || true
  )
  if [[ -n "$residual" ]]; then
    RESIDUAL_COUNT=$(printf '%s\n' "$residual" | wc -l | tr -d ' ')
    printf '%s\n' "$residual" >"$ROUND_DIR/residual-processes.txt"
    set_round_error "$round" "residual app processes remain"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  local log_files=("$stdout_log" "$stderr_log")
  local log_file
  while IFS= read -r log_file; do
    log_files+=("$log_file")
  done < <(find "$logs_dir" -type f -name '*.log' -print)
  if grep -Eqi 'panic|fatal error|crash|permission denied|找不到应用内置的 ffmpeg' \
    "${log_files[@]}"; then
    set_round_error "$round" "runtime error signature found in logs"
    write_round_json "$round" "fail" "$ROUND_DIR"
    return 1
  fi

  write_round_json "$round" "pass" "$ROUND_DIR"
  echo "QR generated in ${STARTUP_MS} ms; ffmpeg $EXPECTED_FFMPEG; exit SIGTERM; no residual processes"

  if [[ "$KEEP_ROUND_DATA" != "1" ]]; then
    rm -rf "$apps_dir" "$home_dir" "$tmp_dir"
  fi
}

PASSED=0
FAILED=0
for round in $(seq 1 "$ROUNDS"); do
  if run_round "$round"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

{
  echo "tag	$TAG"
  echo "version	$VERSION"
  echo "architecture	$ARCH"
  echo "hostArchitecture	$(uname -m)"
  echo "roundsRequested	$ROUNDS"
  echo "roundsPassed	$PASSED"
  echo "roundsFailed	$FAILED"
  echo "dmg	$DMG"
  echo "dmgSha256	$ACTUAL_SHA"
  echo "verifiedAt	$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUTPUT_DIR/summary.tsv"

{
  printf '{\n'
  printf '  "tag": "%s",\n' "$(json_escape "$TAG")"
  printf '  "version": "%s",\n' "$(json_escape "$VERSION")"
  printf '  "architecture": "%s",\n' "$(json_escape "$ARCH")"
  printf '  "hostArchitecture": "%s",\n' "$(json_escape "$(uname -m)")"
  printf '  "hostVersion": "%s",\n' "$(json_escape "$(sw_vers -productVersion)")"
  printf '  "roundsRequested": %s,\n' "$ROUNDS"
  printf '  "roundsPassed": %s,\n' "$PASSED"
  printf '  "roundsFailed": %s,\n' "$FAILED"
  printf '  "dmg": "%s",\n' "$(json_escape "$DMG")"
  printf '  "dmgSha256": "%s",\n' "$ACTUAL_SHA"
  printf '  "verifiedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "results": [\n'
  first=1
  for result in "$OUTPUT_DIR"/round-*/result.json; do
    [[ -f "$result" ]] || continue
    if [[ "$first" == "1" ]]; then
      first=0
    else
      printf ',\n'
    fi
    printf '    %s' "$(cat "$result")"
  done
  printf '\n  ]\n'
  printf '}\n'
} >"$OUTPUT_DIR/summary.json"

echo
echo "Tag       Arch   Passed  Failed"
echo "$TAG       $ARCH   $PASSED      $FAILED"
echo "Summary: $OUTPUT_DIR/summary.json"

if [[ "$FAILED" != "0" ]]; then
  exit 1
fi
