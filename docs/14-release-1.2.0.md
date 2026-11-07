# MiHome Mac 1.2.0 发布记录

状态：源码版本、安装包版本和下载入口已统一到 `1.2.0`。本记录对应 tag
`v1.2.0`，安装包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证。

## 发布范围

- 接入中心支持飞书事件长连接、企业微信智能机器人长连接和钉钉企业内部机器人
  Stream 长连接，无需公网回调。
- 支持本地规则与 OpenAI 兼容模型解析，覆盖组合动作、批量设备、排除范围、
  状态查询、场景执行和高风险操作确认。
- 飞书语音在本机通过 Whisper.cpp 转写；企业微信和钉钉优先使用平台转写。
- 新增 35 个界面 locale、阿拉伯语/希伯来语 RTL 布局和设置页即时切换。
- 修复共享设备未合并、登录 401 后二维码卡住、同房间多灯误判、控制后状态
  回读延迟，以及睡眠或断网后的机器人长连接恢复。
- 完整变更见 [CHANGELOG](../CHANGELOG.md)，接入与安全边界见
  [AI 指令与平台接入](12-ai-platform-integration.md)。

## 源码验证

执行日期：2026-11-07。

```text
npm run check                 通过
i18n                         35 locales / 34,335 translations
npm test                     39/39 通过
cargo fmt (core)             通过
cargo clippy (core)          通过
cargo test (core)            121/121 通过
cargo fmt (desktop)          通过
cargo clippy (desktop)       通过
cargo test (desktop)         27/27 通过
UI_I18N_ALL=1                 35 locales，通过
UI regression                 3913 checks / 101 screenshots
```

UI 回归覆盖桌面与窄屏、LTR/RTL、控件截断、横向溢出、残留中文、动态节点和
运行时错误。测试使用离线 Mock 数据，不代表真实账号、设备或平台凭据验证。

## 安装包结构验证

两个 DMG 均通过 `scripts/verify-macos-bundle.sh`，主程序、go2rtc 和 FFmpeg
架构一致，包内代码签名有效，内置 FFmpeg 为 `8.1.3`。

x64 DMG 在 Intel macOS 15.7.9 上完成 1 轮全新隔离安装与启动：

```text
启动耗时     4629 ms
扫码二维码   已生成
架构         x86_64
动态依赖     system-only
退出方式     SIGTERM
残留进程     0
```

arm64 DMG 已完成包体、架构、代码签名、内置依赖和 FFmpeg 结构验证。由于本次
本地构建宿主为 Intel，arm64 启动验证由原生 arm64 CI runner 继续执行。

## 发布包

| 产物 | 大小（bytes） | SHA256 |
|---|---:|---|
| `MiHome-Mac-1.2.0-arm64.dmg` | 12,348,206 | `9ab280574916e49231b68f2e92be8a8845ff072a21b519d51140f961b3a7586d` |
| `MiHome-Mac-1.2.0-x64.dmg` | 14,933,805 | `6bd641d7e30076a7d54c9914bfd463b23bf957ef5de20d7d8638f032b55ea72c` |

每个 DMG 同时提供对应 `.sha256` 文件。

## 已知边界

- 发布包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证；首次打开仍可能
  需要在访达右键选择「打开」。
- 飞书、企业微信和钉钉需要企业管理员创建自建应用或自建机器人并填写凭据，
  不是普通用户扫码即用的共享机器人。
- Mac 必须保持在线；电脑睡眠、退出应用或断网时无法处理新的控制消息。
- 35 个界面 locale 不等于 35 种语音和自然语言控制语言。
