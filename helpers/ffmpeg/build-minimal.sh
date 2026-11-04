#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
ARCH=${1:-}
OUTPUT=${2:-}
JOBS=${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}

FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=09f990289327d3ebfedf4fc15cae3f884a65dab7a5aac7bbb5b01ff83900efd9
X264_COMMIT=31e19f92f00c7003fa115047ce50978bc98c3a0d
X264_SHA256=d053c9d86988d6bc78237ca5205865c5ddf99c98ef4cd9927eec8f6d388f6dd9
OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
MACOS_MIN=13.0

case "$ARCH" in
  arm64)
    APPLE_ARCH=arm64
    HOST=aarch64-apple-darwin
    TRIPLE=aarch64-apple-darwin
    FFMPEG_ARCH=arm64
    ;;
  x64|amd64|x86_64)
    ARCH=x64
    APPLE_ARCH=x86_64
    HOST=x86_64-apple-darwin
    TRIPLE=x86_64-apple-darwin
    FFMPEG_ARCH=x86_64
    ;;
  *)
    echo "用法：$0 [arm64|x64] [输出文件]" >&2
    exit 1
    ;;
esac

if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$ROOT/ffmpeg-$TRIPLE"
fi

for tool in curl tar make clang pkg-config; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "缺少构建工具：$tool" >&2
    exit 1
  }
done
if [[ "$ARCH" == "x64" ]] && ! command -v nasm >/dev/null 2>&1; then
  echo "Intel 构建需要 nasm：brew install nasm" >&2
  exit 1
fi

SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
CFLAGS="-arch $APPLE_ARCH -isysroot $SDKROOT -mmacosx-version-min=$MACOS_MIN -O2 -fPIC"
LDFLAGS="-arch $APPLE_ARCH -isysroot $SDKROOT -mmacosx-version-min=$MACOS_MIN"

CACHE_ROOT=${MIHOME_FFMPEG_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/Library/Caches}/mihome-mac/ffmpeg}
RECIPE_HASH=$(shasum -a 256 "$0" | awk '{ print $1 }')
BUILD_ROOT="$CACHE_ROOT/builds/$RECIPE_HASH/$ARCH"
DEPS="$BUILD_ROOT/deps"
OUTPUT_CACHE="$CACHE_ROOT/artifacts/$RECIPE_HASH/ffmpeg-$ARCH"

mkdir -p "$CACHE_ROOT/downloads" "$CACHE_ROOT/src" "$BUILD_ROOT" "$DEPS" \
  "$(dirname "$OUTPUT")"

download_checked() {
  url=$1
  expected=$2
  destination=$3
  if [[ ! -f "$destination" ]]; then
    curl -fL --retry 3 --retry-delay 2 -o "$destination.tmp" "$url"
    mv "$destination.tmp" "$destination"
  fi
  actual=$(shasum -a 256 "$destination" | awk '{ print $1 }')
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA256 校验失败：$destination" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
}

extract_checked() {
  archive=$1
  destination=$2
  marker="$destination/.extracted"
  if [[ ! -f "$marker" ]]; then
    mkdir -p "$destination"
    tar -xf "$archive" -C "$destination" --strip-components=1
    touch "$marker"
  fi
}

build_x264() {
  prefix="$DEPS/x264"
  if [[ -f "$prefix/lib/pkgconfig/x264.pc" ]]; then
    return
  fi

  work="$BUILD_ROOT/x264"
  mkdir -p "$work"
  cp -R "$CACHE_ROOT/src/x264/." "$work/"
  (
    cd "$work"
    CC=clang CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" \
      ./configure \
        --prefix="$prefix" \
        --host="$HOST" \
        --enable-static \
        --disable-cli \
        --enable-pic
    make -j "$JOBS"
    make install
  )
}

build_opus() {
  prefix="$DEPS/opus"
  if [[ -f "$prefix/lib/pkgconfig/opus.pc" ]]; then
    return
  fi

  work="$BUILD_ROOT/opus"
  mkdir -p "$work"
  cp -R "$CACHE_ROOT/src/opus/." "$work/"
  (
    cd "$work"
    CC=clang CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" \
      ./configure \
        --prefix="$prefix" \
        --host="$HOST" \
        --disable-shared \
        --enable-static \
        --disable-doc \
        --disable-extra-programs
    make -j "$JOBS"
    make install
  )
}

build_ffmpeg() {
  work="$BUILD_ROOT/ffmpeg"
  mkdir -p "$work"
  cp -R "$CACHE_ROOT/src/ffmpeg/." "$work/"
  (
    cd "$work"
    # Official release tarballs contain RELEASE but not VERSION. Without a
    # .git directory, ffbuild/version.sh can otherwise fall back to a parent
    # repository and stamp the binary with an unrelated commit id.
    if [[ -f RELEASE && ! -f VERSION ]]; then
      cp RELEASE VERSION
    fi
    export PKG_CONFIG_PATH="$DEPS/x264/lib/pkgconfig:$DEPS/opus/lib/pkgconfig"
    ./configure \
      --prefix="$BUILD_ROOT/install" \
      --target-os=darwin \
      --arch="$FFMPEG_ARCH" \
      --cc=clang \
      --pkg-config=pkg-config \
      --pkg-config-flags=--static \
      --enable-cross-compile \
      --extra-cflags="$CFLAGS" \
      --extra-ldflags="$LDFLAGS" \
      --disable-everything \
      --disable-autodetect \
      --disable-debug \
      --disable-doc \
      --disable-shared \
      --enable-static \
      --enable-gpl \
      --enable-version3 \
      --enable-network \
      --enable-libx264 \
      --enable-libopus \
      --enable-videotoolbox \
      --enable-demuxer=h264,hevc,rtsp,sdp \
      --enable-decoder=h264,hevc,opus \
      --enable-encoder=libx264,h264_videotoolbox,libopus,pcm_alaw \
      --enable-muxer=rtsp \
      --enable-filter=scale,fps,aresample,format \
      --enable-parser=h264,hevc,opus \
      --enable-protocol=file,pipe,tcp,udp,rtp,http
    make -j "$JOBS" ffmpeg
  )
}

verify_binary() {
  binary=$1
  expected_arch=$2
  archs=$(lipo -archs "$binary")
  if [[ " $archs " != *" $expected_arch "* ]]; then
    echo "架构不符合预期：$binary ($archs)" >&2
    exit 1
  fi

  while IFS= read -r dependency; do
    case "$dependency" in
      /usr/lib/*|/System/Library/*) ;;
      *)
        echo "发现非系统动态依赖：$dependency" >&2
        exit 1
        ;;
    esac
  done < <(otool -L "$binary" | tail -n +2 | awk '{ print $1 }')

  # A macOS host can inspect both slices, but it can only execute the slice
  # matching its own CPU. Cross-built arm64 binaries are therefore validated
  # with lipo/otool here and exercised on the native build host.
  host_arch=$(uname -m)
  if [[ " $archs " == *" $host_arch "* ]]; then
    version=$("$binary" -hide_banner -version 2>&1 | head -n 1)
    [[ "$version" == "ffmpeg version $FFMPEG_VERSION "* ]] || {
      echo "FFmpeg 版本不符合预期：$version" >&2
      exit 1
    }

    encoders=$("$binary" -hide_banner -encoders 2>/dev/null)
    for encoder in libx264 h264_videotoolbox libopus pcm_alaw; do
      printf '%s\n' "$encoders" | grep -q " $encoder " || {
        echo "缺少编码器：$encoder" >&2
        exit 1
      }
    done
    "$binary" -hide_banner -muxers 2>/dev/null | grep -q 'rtsp' || {
      echo "缺少 RTSP muxer" >&2
      exit 1
    }
  else
    echo "跳过非宿主架构的执行检查：$binary ($archs)"
  fi
}

if [[ "${MIHOME_FFMPEG_FORCE_BUILD:-0}" != "1" && -x "$OUTPUT_CACHE" ]]; then
  verify_binary "$OUTPUT_CACHE" "$APPLE_ARCH"
  install -m 755 "$OUTPUT_CACHE" "$OUTPUT"
  echo "复用最小 FFmpeg 构建：$OUTPUT"
  exit 0
fi

download_checked \
  "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n${FFMPEG_VERSION}.tar.gz" \
  "$FFMPEG_SHA256" \
  "$CACHE_ROOT/downloads/ffmpeg-${FFMPEG_VERSION}.tar.gz"
download_checked \
  "https://github.com/mirror/x264/archive/${X264_COMMIT}.tar.gz" \
  "$X264_SHA256" \
  "$CACHE_ROOT/downloads/x264-${X264_COMMIT}.tar.gz"
download_checked \
  "https://github.com/xiph/opus/releases/download/v${OPUS_VERSION}/opus-${OPUS_VERSION}.tar.gz" \
  "$OPUS_SHA256" \
  "$CACHE_ROOT/downloads/opus-${OPUS_VERSION}.tar.gz"

extract_checked "$CACHE_ROOT/downloads/ffmpeg-${FFMPEG_VERSION}.tar.gz" "$CACHE_ROOT/src/ffmpeg"
extract_checked "$CACHE_ROOT/downloads/x264-${X264_COMMIT}.tar.gz" "$CACHE_ROOT/src/x264"
extract_checked "$CACHE_ROOT/downloads/opus-${OPUS_VERSION}.tar.gz" "$CACHE_ROOT/src/opus"

build_x264
build_opus
build_ffmpeg

binary="$BUILD_ROOT/ffmpeg/ffmpeg"
verify_binary "$binary" "$APPLE_ARCH"
mkdir -p "$(dirname "$OUTPUT_CACHE")"
install -m 755 "$binary" "$OUTPUT_CACHE"
install -m 755 "$binary" "$OUTPUT"

echo "最小 FFmpeg $FFMPEG_VERSION ($ARCH) 已生成：$OUTPUT"
ls -lh "$OUTPUT"
