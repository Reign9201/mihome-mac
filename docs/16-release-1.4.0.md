# MiHome Mac 1.4.0 发布记录

状态：源码版本、安装包版本和下载入口已统一到 `1.4.0`。本记录对应 tag
`v1.4.0`，安装包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证。

## 发布范围

- 菜单栏速控面板：菜单栏图标左键弹出常用设备和场景，`⌥M` 全局呼出；
  支持跨全屏显示、设备搜索、房间筛选和键盘导航，面板内容按米家账号保存。
- 应用内升级：匿名检查 GitHub Releases，按架构匹配 DMG 与 `.sha256`，
  流式下载显示进度并校验 SHA256，安装后自动重启；启动时每 24 小时静默检查。
- 账号凭据迁移到 macOS 钥匙串，老用户首次启动自动迁移并删除明文副本。
- 双摄摄像头：按小米官方机型表展开 `ch0`/`ch1`，本地 go2rtc 与远程 MISS
  均支持副镜头；固定镜头隐藏云台和声音入口，计数与在线状态按物理设备处理。
- 摄像头链路稳定性：同网段预检、重连退避与熔断、30 秒无新帧失效、
  本地通道失败自动改用远程画面、停止请求合并。
- 主题自动/浅色/深色三态、macOS 滚动条修复、减弱动效调整、拼音首字母搜索。
- 完整变更见 [CHANGELOG](../CHANGELOG.md)。

## 源码验证

执行日期：2026-11-19。

```text
npm run check                 通过
i18n                         35 locales / 38,045 translations
npm test                     45/45 通过
cargo fmt (core)             通过
cargo clippy (core)          通过
cargo test (core)            146/146 通过
cargo clippy (desktop)       通过
cargo test (desktop)         40/40 通过
UI regression                5 rounds / 7,186 checks / 468 screenshots
UI_I18N_ALL=1                35 locales，通过
test:dual                    13 checks，通过
test:quick                   全部通过
test:perf (PERF_STALL=1)     152 台摄像头 / 279 台设备，通过
```

测试使用离线模拟数据，不代表真实账号、设备或平台凭据验证。双摄的第二镜头
仍需要在真实双摄机型上验证。

## 发布包

| 产物 | 大小（bytes） | SHA256 |
|---|---:|---|
| `MiHome-Mac-1.4.0-arm64.dmg` | 12,571,807 | `8423a3bea6e0d17fb08ec60f65c275bb6f3d6a63af0d573e75cc480c2682816c` |
| `MiHome-Mac-1.4.0-x64.dmg` | 15,027,285 | `5dfe48f265674184bce010041040823b240f4747f896e2cfc0f8d04c12e9ac74` |

每个 DMG 同时提供对应 `.sha256` 文件。

tag 触发的 arm64/x64 远端构建与包体验证均通过：
[`44492233126`](https://github.com/Reign9201/mihome-mac/actions/runs/44492233126)。
tag 和 main 的 CI 均通过：
[`44492233062`](https://github.com/Reign9201/mihome-mac/actions/runs/44492233062)、
[`44492221687`](https://github.com/Reign9201/mihome-mac/actions/runs/44492221687)。

## 已知边界

- 发布包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证；首次打开仍可能
  需要在访达右键选择「打开」。
- 双摄的副镜头通道号以机型实际固件为准；同时拉取两路会占用两个会话，
  米家 App 可能因此无法观看该摄像头。
- 应用内升级需要能访问 GitHub Releases；直连失败时会尝试 macOS 系统代理。
- 菜单栏面板依赖 `NSPanel` 行为，全屏应用下的显示效果需要在真实桌面环境验证。

## 术语说明

**ad-hoc 签名**：不使用苹果开发者证书的本地签名，系统首次打开时会提示来源未知。

**Developer ID / Apple 公证**：苹果发给开发者的签名证书和苹果的安全扫描流程，两者都有时系统不会拦截首次打开。

**clippy**：Rust 官方的代码检查工具，用来发现常见写法问题。

**UI regression**：用模拟数据驱动界面、逐页检查布局和功能的自动化测试。

**UI_I18N_ALL**：让界面回归测试依次切换 35 种界面语言并检查翻译残留和文字截断的开关。

**test:perf**：用大量模拟摄像头和设备检查页面切换、渲染耗时和取流路数的性能测试。

**PERF_STALL**：性能测试中模拟某一路摄像头卡住，检查其他画面是否继续播放的开关。
