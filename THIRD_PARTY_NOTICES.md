# Third-Party Notices

MiHome Mac is licensed under GPL-3.0-or-later. This file records the upstream
projects and third-party components that informed or are distributed with the
application. It was last reviewed on 2026-11-06.

## Protocol and product references

### Do1e/mijia-api

- Project: https://github.com/Do1e/mijia-api
- License: GPL-3.0-or-later
- Use: Reference for Xiaomi cloud login, request signing, cloud endpoints, and
  device models. Relevant protocol logic was independently rewritten in Rust.

### huanyuejue/MiHome-Windows

- Project: https://github.com/huanyuejue/MiHome-Windows
- License: GPL-3.0 or later
- Use: Reference for desktop feature organization, interaction patterns, and
  device control flows. The macOS implementation and interface were rewritten.

### Squachen/micloud

- Project: https://github.com/Squachen/micloud
- License: MIT
- Use: Early reference for Xiaomi cloud login and RC4 signing, consulted
  indirectly through mijia-api.

## Protocol research only

The following projects were consulted to validate protocol behavior. Their source
code and binaries are not included in this repository or its application bundle.

### XiaoMi/ha_xiaomi_home

- Project: https://github.com/XiaoMi/ha_xiaomi_home
- License: Xiaomi custom license, limited to non-commercial use inside Home
  Assistant
- Use: Read-only protocol research. No source code is copied or distributed.

### eugeneRover/micam

- Project: https://github.com/eugeneRover/micam
- License: No license declared
- Use: Independent verification of CS2 remote streaming feasibility only. No
  source code or binary is copied or distributed.

## Distributed components

### lark-channel

- Project: https://github.com/jacoesad/channel-sdk-rust
- Version: 0.6.0
- License: MIT
- Use: Feishu/Lark WebSocket event transport, event normalization, and message
  replies. Linked into the desktop binary.

### tokio-tungstenite / tungstenite

- Projects: https://github.com/snapview/tokio-tungstenite and
  https://github.com/snapview/tungstenite-rs
- Version: 0.26.x
- License: MIT
- Use: Enterprise WeChat intelligent-bot WebSocket long connection and Feishu
  WebSocket transport. Linked into the desktop binary.

### dingtalk-stream-sdk

- Project: https://github.com/wenhaozhao/dingtalk-stream-sdk-rust
- Version: 0.2.5
- License: MIT OR Apache-2.0
- Use: DingTalk robot Stream long connection, authentication, callbacks, and
  session webhook replies. Linked into the desktop binary.

### whisper.cpp

- Project: https://github.com/ggml-org/whisper.cpp
- Version: 1.9.5
- License: MIT
- Use: Optional local speech-to-text runtime. The executable and its dynamic
  libraries are installed under the user's MiHome application-support directory;
  the GGML model is downloaded separately and is not included in the repository.

### AlexxIT/go2rtc

- Project: https://github.com/AlexxIT/go2rtc
- Version: 1.9.15
- License: MIT
- Use: Local camera streaming helper launched as a separate process. The binary
  is not committed to the repository. Its license is preserved at
  `helpers/go2rtc/LICENSE` and `go2rtc-LICENSE` in the application bundle.

### FFmpeg

- Project: https://ffmpeg.org/
- Version: 8.1.3
- Corresponding source: https://github.com/FFmpeg/FFmpeg/tree/n8.1.3
- Build recipe: `helpers/ffmpeg/build-minimal.sh`
- Build configuration: `--enable-gpl --enable-version3 --disable-shared
  --enable-static --disable-everything`, with only the camera codecs,
  demuxers, muxers, protocols, and filters enabled
- License: GPL-3.0-or-later
- Use: Runtime child process for low-latency H.264 transcoding and RTSP
  publishing for local and remote camera streams.
- Distribution: The binary is built from fixed source versions, verified by
  SHA256 before bundling, and installed as `Contents/MacOS/ffmpeg`; users do not
  need Homebrew or a separate FFmpeg installation. Binaries are not committed
  to the repository.
- License files: `ffmpeg-LICENSE` and `ffmpeg-COPYING.GPLv3` in the application
  bundle.

### x264

- Project: https://www.videolan.org/developers/x264.html
- Version: commit `31e19f92f00c7003fa115047ce50978bc98c3a0d`
- Corresponding source:
  https://code.videolan.org/videolan/x264/-/tree/31e19f92f00c7003fa115047ce50978bc98c3a0d
- License: GPL-2.0-or-later
- Use: Statically linked H.264 software encoder in the bundled FFmpeg.
- License file: `ffmpeg-x264-COPYING` in the application bundle.

### Xiph.Org Opus

- Project: https://opus-codec.org/
- Version: 1.5.2
- Corresponding source:
  https://github.com/xiph/opus/releases/tag/v1.5.2
- License: BSD-3-Clause
- Use: Statically linked Opus encoder in the bundled FFmpeg.
- License file: `ffmpeg-opus-COPYING` in the application bundle.

## Language and package dependencies

Rust crate licenses are recorded in `core/Cargo.lock` and
`desktop/src-tauri/Cargo.lock`; Node.js dependency licenses are recorded in
`desktop/package-lock.json`. Those dependencies remain under their respective
licenses.

The complete GPL-3.0 license text for MiHome Mac is in `LICENSE`. The source code
needed to build and modify the distributed application is available at:

https://github.com/Reign9201/mihome-mac
