# MiHome Mac 1.1.0 发布与回归记录

状态：待发布验证。版本号、CHANGELOG、README 下载入口和发布素材已更新到 1.1.0。

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

## 待完成

- 提交并推送 `main`。
- 等待 GitHub Actions CI 成功。
- 推送 `v1.1.0` 标签并等待两个 DMG 构建完成。
- 验证 arm64、x64 DMG 架构、签名、go2rtc 和 SHA256。
- 创建 GitHub Release。
- 发布小红书和 X。
