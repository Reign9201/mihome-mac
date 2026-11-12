# MiHome Mac 1.3.0 发布记录

状态：源码版本、安装包版本和下载入口已统一到 `1.3.0`。本记录对应 tag
`v1.3.0`，安装包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证。

## 发布范围

- 用电统计：插座等带“用电量”属性的设备，在详情里按 7 天、30 天、12 个月
  显示柱状图、合计和平均值，数据来自米家云端统计接口。
- 小爱音箱面板：输入文字让音箱执行（可选不出声）或直接播报，播放控制改为
  一排按键。
- 顶部导航显示温湿度、开着和在线的设备数，耗材剩余不到 20% 时提醒；恢复
  按房间标注的经典设备卡片样式。
- 监控页：侧栏搜索、宫格分页（本地 9 路 / 远程 6 路）、点格子打开单画面、
  单路失败不影响其他画面；远程摄像头并发建链，翻页或停止时可中途取消。
- 性能：150 台摄像头时监控页高度从约 25700px 降到约 1000px，启动属性读取
  从 557 项降到 294 项；279 台设备时设备页和总览渲染耗时下降约 40%。
- 飞书机器人进群欢迎语、平台连接失败分类提示、回复带单位、语音识别提速。
- 完整变更见 [CHANGELOG](../CHANGELOG.md)。

## 源码验证

执行日期：2026-11-12。

```text
npm run check                 通过
i18n                         35 locales / 36,505 translations
npm test                     41/41 通过
cargo fmt (core)             通过
cargo clippy (core)          通过
cargo test (core)            127/127 通过
cargo fmt (desktop)          通过
cargo clippy (desktop)       通过
cargo test (desktop)         31/31 通过
UI regression                10 rounds / 5122 checks / 700 screenshots
UI_I18N_ALL=1                35 locales / 5018 checks，通过
test:perf (PERF_STALL=1)     152 台摄像头 / 279 台设备，通过
```

测试使用离线模拟数据，不代表真实账号、设备或平台凭据验证。用电统计和小爱
音箱面板尚未在真实插座和音箱上验证。

## 发布包

| 产物 | 大小（bytes） | SHA256 |
|---|---:|---|
| `MiHome-Mac-1.3.0-arm64.dmg` | 12,497,822 | `119573bfc90ac4faa55f337c5c9e9f4f3a6681767cc05be5166487e24ceb1387` |
| `MiHome-Mac-1.3.0-x64.dmg` | 14,874,057 | `e7b289ec2ba42db4faac2b957c9f6df99b9cd7101edbee4ca2e9e8fbb30a3ff0` |

每个 DMG 同时提供对应 `.sha256` 文件。

tag 触发的 arm64/x64 远端构建与包体验证均通过：
[`43137699856`](https://github.com/Reign9201/mihome-mac/actions/runs/43137699856)。
tag 和 main 的 CI 均通过：
[`43137699803`](https://github.com/Reign9201/mihome-mac/actions/runs/43137699803)、
[`43137696029`](https://github.com/Reign9201/mihome-mac/actions/runs/43137696029)。

arm64 DMG 下载后在本机（Apple Silicon）再次执行 `scripts/verify-macos-bundle.sh`，
主程序、go2rtc 和 FFmpeg 的 ad-hoc 签名校验通过。本次没有做全新隔离安装与启动
回归，可通过 `Release DMG regression` 工作流补跑。

## 已知边界

- 发布包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证；首次打开仍可能
  需要在访达右键选择「打开」。
- 不同型号插座在云端的统计项和数值比例可能不同；规格未写明 kWh 或 Wh 时界面
  不显示单位，部分老设备可能显示“没有用电记录”。
- 小爱音箱文字指令依赖设备规格里的 `execute-text-directive` 和 `play-text`
  动作，没有这两个动作的音箱不显示输入框。
- 飞书、企业微信和钉钉仍需要企业管理员创建自建应用或自建机器人并填写凭据。

## 术语说明

**ad-hoc 签名**：不使用苹果开发者证书的本地签名，系统首次打开时会提示来源未知。

**Developer ID / Apple 公证**：苹果发给开发者的签名证书和苹果的安全扫描流程，两者都有时系统不会拦截首次打开。

**clippy**：Rust 官方的代码检查工具，用来发现常见写法问题。

**UI regression**：用模拟数据驱动界面、逐页检查布局和功能的自动化测试。

**UI_I18N_ALL**：让界面回归测试依次切换 35 种界面语言并检查翻译残留和文字截断的开关。

**test:perf**：用大量模拟摄像头和设备检查页面切换、渲染耗时和取流路数的性能测试。

**PERF_STALL**：性能测试中模拟某一路摄像头卡住，检查其他画面是否继续播放的开关。

**kWh / Wh**：千瓦时和瓦时，用电量单位。
