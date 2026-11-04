# MiHome Mac 1.1.0 发布素材

本目录包含 1.1.0 的小红书与 X 发布素材。

## 图片

- `xhs-01-cover.png`：版本封面
- `xhs-02-accounts.png`：多账号与数据隔离
- `xhs-03-camera.png`：摄像头与全屋控制
- `xhs-04-release.png`：更新摘要

四张图统一为 1080 × 1440。界面截图来自 10 轮 UI 回归第 10 轮，使用离线演示数据。

## 生成

```bash
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --window-size=1080,1440 \
  --virtual-time-budget=1800 \
  --screenshot=marketing/release-1.1.0/xhs-01-cover.png \
  'file:///Users/xuyanjun/Downloads/Study/mihome-mac/marketing/release-1.1.0/slides.html?slide=1'
```

其余图片将 `slide=1` 分别改为 `2`、`3`、`4`，并修改输出文件名。

`assets/` 是从 `desktop/tests/artifacts/` 复制的第 10 轮实际界面截图。发布文案见 `publish-copy.md`。

## 真实性约束

- 只展示当前桌面应用真实渲染的界面。
- 标注“实际界面 · 离线演示数据”。
- 不使用设计原型冒充已完成效果。
- 不展示真实登录二维码、账号凭据、设备 Token 或家庭画面。
- 不承诺绝对零延迟。
