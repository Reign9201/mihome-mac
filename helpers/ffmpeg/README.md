# FFmpeg sidecar

MiHome Mac bundles a minimal static `ffmpeg` binary so camera transcoding works
without a Homebrew or system-wide FFmpeg install.

## Build

- FFmpeg: `8.1.3`
- x264: commit `31e19f92f00c7003fa115047ce50978bc98c3a0d`
- Opus: `1.5.2`
- Target: macOS 13.0 or later, arm64 or x86_64
- License: GPL-3.0-or-later because this build enables GPL and version 3

This is not the full FFmpeg distribution. `build-minimal.sh` uses
`--disable-everything` and enables only the components used by the camera
paths:

- Decoders: H.264, HEVC, Opus
- Encoders: libx264, VideoToolbox H.264, libopus, PCM A-law
- Demuxers/parsers: raw H.264, raw HEVC, RTSP, SDP, Opus
- Muxers/protocols: RTSP, file, pipe, TCP, UDP, RTP, HTTP
- Filters: scale, fps, aresample, format

HLS is produced by the bundled go2rtc process; FFmpeg only publishes RTSP.

## Prepare

```bash
./helpers/ffmpeg/fetch.sh          # Current machine architecture
./helpers/ffmpeg/fetch.sh arm64    # Apple Silicon
./helpers/ffmpeg/fetch.sh x64      # Intel
./helpers/ffmpeg/fetch.sh universal
```

The script builds the fixed source versions, verifies their SHA256 values, and
writes the runtime binary as `ffmpeg` plus the target-triple names Tauri expects
for `externalBin`. During bundling Tauri installs it at:

```text
MiHome Mac.app/Contents/MacOS/ffmpeg
```

The source archives and resulting binaries are fixed by SHA256 in
`checksums.txt`. The binaries are not committed to this repository.

## License compliance

The app bundle includes:

- `ffmpeg-LICENSE` and `ffmpeg-COPYING.GPLv3`
- `ffmpeg-x264-COPYING`
- `ffmpeg-opus-COPYING`

The build recipe and source URLs are in this directory. The corresponding
FFmpeg source is available from:

```text
https://github.com/FFmpeg/FFmpeg/tree/n8.1.3
```
