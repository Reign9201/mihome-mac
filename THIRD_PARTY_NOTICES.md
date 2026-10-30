# Third-Party Notices

MiHome Mac is licensed under GPL-3.0-or-later. This file records the upstream
projects and third-party components that informed or are distributed with the
application. It was last reviewed on 2026-10-30.

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

### AlexxIT/go2rtc

- Project: https://github.com/AlexxIT/go2rtc
- Version: 1.9.15
- License: MIT
- Use: Local camera streaming helper launched as a separate process. The binary
  is not committed to the repository. Its license is preserved at
  `helpers/go2rtc/LICENSE` and `go2rtc-LICENSE` in the application bundle.

## Language and package dependencies

Rust crate licenses are recorded in `core/Cargo.lock` and
`desktop/src-tauri/Cargo.lock`; Node.js dependency licenses are recorded in
`desktop/package-lock.json`. Those dependencies remain under their respective
licenses.

The complete GPL-3.0 license text for MiHome Mac is in `LICENSE`. The source code
needed to build and modify the distributed application is available at:

https://github.com/Reign9201/mihome-mac
