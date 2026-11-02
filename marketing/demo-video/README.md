# MiHome Mac 演示素材

面向小红书、抖音的 9:16 竖屏演示素材。画面全部来自当前桌面应用的实际 UI，通过离线 mock IPC 注入确定性演示数据，不包含真实二维码、设备凭据或个人家庭画面。

> `prototype/` 和 `docs/assets/shot-*.jpg` 是终极设计目标，不是当前应用效果。发布素材不得把设计原型与已完成功能混剪。

## 成品

| 文件 | 用途 |
|---|---|
| `mihome-mac-demo-1080x1920.mp4` | 46.5 秒竖屏演示视频 |
| `cover-xhs.png` | 小红书 3:4 封面，1080 × 1440 |
| `cover-douyin.png` | 抖音 9:16 封面，1080 × 1920 |
| `publish-copy.md` | 两个平台的标题、正文、标签和置顶评论 |
| `storyboard.md` | 分镜、时长和信息层级 |
| `voiceover.txt` | 配音文案 |
| `preview-contact-sheet.jpg` | 全片镜头预览 |
| `assets/actual-*.png` | 当前实际应用截图，供分镜和封面复用 |

## 视频规格

- 分辨率：1080 × 1920
- 帧率：30 fps
- 视频：H.264 High、`yuv420p`
- 音频：AAC、48 kHz、单声道
- 时长：46.5 秒
- 大小：约 11 MB

## 重新生成

依赖 `ffmpeg`、`ffprobe`、`uv` 和 GitHub 开源项目 `rany2/edge-tts`。旁白使用更自然的
`zh-CN-XiaoxiaoNeural`，而不是 macOS 系统 `Tingting`：

```bash
./marketing/demo-video/generate-voiceover.sh
python3 marketing/demo-video/render.py
```

分镜画面位于 `scenes.html`，实际 UI 由 `actual-ui.html` 复用 `desktop/ui` 的 HTML、CSS、图标、能力解析和 `app.js`，只通过 `actual-ui-demo.js` 注入演示数据。截图前需要启动仓库根目录的静态服务，然后以 1080 × 1920 视口逐场景截图到 `build/frames/`：

```bash
python3 -m http.server 8899
# 浏览器打开 scenes.html?scene=1 到 scene=7，分别截图
```

`build/` 是中间产物目录，不纳入版本控制。封面和分镜使用的实际界面截图已复制到 `assets/`，不依赖被忽略的 `build/`。

## 画面真实性

- 每个含应用画面的分镜都标注“实际界面 · 演示数据”。
- 视频不展示真实摄像头画面、二维码、账号、Token 或家庭日志。
- 视频只描述当前界面可见或已验证的能力，不宣传尚未对齐的设计稿效果。
- 不承诺绝对零延迟；摄像头首次连接和稳定延迟受网络、固件、relay 状态影响。

## 发布前检查

- 确认仓库地址和许可证信息没有变更。
- 保留“开源、非官方”说明，避免被理解为小米官方产品。
- 延迟统一表述为“约 1 秒级”，不要承诺绝对零延迟。
- 不要将真实登录二维码、设备 Token、家庭画面或诊断日志放进宣传素材。
- 不要把 `prototype/` 截图当作当前产品效果发布。
