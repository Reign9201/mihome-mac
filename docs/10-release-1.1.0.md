# MiHome Mac 1.1.0 发布与回归记录

状态：已发布。版本号、CHANGELOG、README 下载入口和发布素材均已更新到 1.1.0。

## 发布范围

- 多账号保存、添加、切换、退出和剩余账号自动回退。
- 账号之间的家庭、设备、摄像头、场景和自动化数据隔离。
- 新顶部导航及总览、监控、场景、自动化、全部设备、设置和登录页。
- 设备在线状态静默同步、窗口聚焦即时刷新和路由器状态修复。
- 全局禁止文本选择、拖拽、复制、剪切和右键菜单。
- Apple Silicon（arm64）与 Intel（x64）两个独立 DMG，均内置对应架构 go2rtc。

## 本地回归

执行日期：2026-11-04。

```text
npm run check                 通过
npm test                      38/38 通过
npm audit --audit-level=high  0 vulnerabilities
cargo fmt (core)              通过
cargo clippy (core)           通过
cargo test (core)             73/73 通过
cargo fmt (desktop)           通过
cargo clippy (desktop)        通过
UI_REGRESSION_ROUNDS=10       通过
```

10 轮 UI 回归结果：

```json
{
  "rounds": 10,
  "checks": 3952,
  "screenshots": 620,
  "maxInteractionMs": 39.9,
  "domNodes": 1088,
  "heapMB": 2.69,
  "runtimeErrors": [],
  "failures": []
}
```

截图位于 `desktop/tests/artifacts/`。截图使用离线 Mock 数据，只验证界面、交互、布局和状态流，不代表真实账号设备。

## 发布素材

- 四张 1080 × 1440 图片位于 `marketing/release-1.1.0/`。
- 图片全部使用第 10 轮实际界面截图，并标注“实际界面 · 离线演示数据”。
- 小红书与 X 文案位于 `marketing/release-1.1.0/publish-copy.md`。

## 发布结果

- GitHub Release：[v1.1.0](https://github.com/Reign9201/mihome-mac/releases/tag/v1.1.0)
- CI：`41809713124`，全部通过
- DMG 构建：`41810924170`，arm64 与 x64 均通过
- Apple Silicon DMG：`MiHome-Mac-1.1.0-arm64.dmg`，8,017,952 bytes
- Intel DMG：`MiHome-Mac-1.1.0-x64.dmg`，9,618,628 bytes
- 两个 DMG 均通过挂载、架构、ad-hoc 签名、许可证资源和内置 go2rtc 校验
- 小红书：已发布「米家搬进Mac，1.1.0更新了什么」，笔记 ID `6aeb04010000000015004be0`
- X：[发布帖子](https://x.com/reign9201/status/2117921953080389816)

## SHA256

```text
ba7560a40a5acecc274821c53324f50fa4c437c1f4e5f561fbf45d4d7e7d9f85  MiHome-Mac-1.1.0-arm64.dmg
fb69e9f66fdaa4449579e097940f8dfa3c0354c74c4e6a5216909fa5346865bc  MiHome-Mac-1.1.0-x64.dmg
```

## 已知边界

- 发布包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证。
- 摄像头首帧、延迟和稳定性仍受局域网、固件、relay 与网络质量影响。
- 云存储事件、录像回放、手动录制和隐私遮蔽仍受米家第三方接口能力限制。
- 营销截图来自离线演示数据，不代表任何真实账号的设备状态。
