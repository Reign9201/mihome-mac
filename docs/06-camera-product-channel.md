# 摄像头产品通道

日期：2026-10-30 · 状态：Rust 产品通道两路已在 App 内同时出画并连续播放 10 分 33 秒，069a01 云台已确认位移

## 1. 当前状态

macOS App 的摄像头页有两条通道：

| 通道 | 实现 | 网络条件 | 现状 |
|---|---|---|---|
| 本地 | go2rtc 的 `xiaomi://` 源 | Mac 与摄像头同一局域网 | 代码已接；本机因跨网段未出首帧 |
| 远程 | Rust：CS2 relay + MISS + ffmpeg HLS | 跨网段，走小米 relay | 已出 HEVC 真画面，App 内可播放 |

远程验证对象是 `chuangmi.camera.039a01`，quality 2 输出 864×480 HEVC。命令行探针在 12 秒内收到 238 个媒体包、90,433 字节；ffprobe 识别为 `hevc 864x480`，ffmpeg 成功解码一帧。App 内画面带摄像头时间水印，构建后的进程列表里只有 `mihome-mac` 和 `ffmpeg`，没有 Java 进程。

`chuangmi.camera.069a01` 在 Rust 通道输出 2960×1666 HEVC 20fps，ffprobe 识别、ffmpeg 解码一帧成功。两路同时启动时，039a01 首帧 18.76 秒、069a01 首帧 20.27 秒；10 秒分别收到 261 帧和 199 帧。App 远程宫格已能同时播放两台摄像头，画面都带摄像头时间水印。

## 2. 为什么不直接打包 micam

micam 是 Java 21 的个人实验项目，仓库没有 LICENSE，只支持单路视频，没有音频。它证明了 CS2 relay 在跨网段可用，但不能作为 MiHome Mac 的发行依赖。产品通道把 cloud 准备、PPPP relay、MISS 会话、媒体解密都放在 Rust 里；`micam` 源码没有进入构建产物。

go2rtc 是 MIT 许可，已有 `pkg/xiaomi/miss` 和 `pkg/xiaomi/miss/cs2`，但 CS2 的握手先向摄像头的局域网地址 `32108/UDP` 发发现包，再打洞；跨网段时没有可用的 relay 入口。它解决局域网，不解决远程。

## 3. 协议拆分

1. **云侧准备**：用 `userId` / `passToken` 调 `/v2/device/miss_get_vendor`，拿摄像头公钥、签名和 relay 参数；客户端生成 X25519 密钥对。
2. **PPPP relay**：向小米 relay 发 `LIST_REQ1`，拿到 relay 地址；在 `25000/UDP` 完成 `RLY_PORT`、`RLY_REQ`、`RLY_RDY`；处理 relay 重复发来的 `0x28` MISS_SETUP，回写本地地址和外部地址。
3. **MISS 会话**：在 relay 通道上发 `0x100` 明文认证 JSON，收到 `0x101` 且包含 `"result":"success"` 后用 HSalsa20 派生会话 key；后续命令用 `0x1001` 包住，正文用 ChaCha20 加密。
4. **媒体**：发 `0x102` 启动视频，收到 32 字节头 + 加密负载；解密后按 codec id 区分 H.264（4）和 H.265（5）。云台用 `0x112`，JSON 是 `{"operation":1}`：1 左、2 右、3 上、4 下。相机每次命令走一个固定步长。

## 4. Rust 模块

```text
core/src/
├── remote_crypto.rs   X25519、HSalsa20、ChaCha20
├── pppp.rs            PPPP 帧、Uid、init string、0x28 回复、媒体重组
├── relay.rs           relay 发现与 RLY_* 状态机、接收线程、命令/媒体通道
├── miss.rs            0x100 认证、0x1001 加解密、0x102 媒体、0x112 云台
├── remote.rs          云侧准备 + relay + MISS 的组合入口
├── remote_stream.rs   媒体帧 → ffmpeg stdin → fMP4 HLS → loopback HTTP
└── media.rs           ffmpeg 路径、端口、HLS 文件服务
```

`RemoteStream` 对上暴露 `start(session, did, quality)`、`url()`、`ptz(direction, speed)`、`frames()`。Tauri 只依赖这个类型，不再知道 Java 或 micam。

### 4.1 关键实现点

- **X25519 字节序**：公钥在线上是 32 字节小端，Rust 直接按字节数组传入，不转大端。
- **会话 key**：X25519 原始共享密钥再做 HSalsa20(zero nonce)，不直接当 ChaCha20 key。
- **ChaCha20**：nonce 是 4 个零字节 + 8 字节随机尾，计数器从 0 开始。
- **PPPP 帧**：32 字节头里有 channel、seq、payload 长度；DRW 负载首字节必须是 `0xD1`，帧类型才是 `0xD0`。这个字节写错会让摄像头一直不回认证。
- **HLS**：用 ffmpeg 把 HEVC Annex-B 转 fMP4 HLS，保证 WKWebView 能播放；后续可换成 VideoToolbox + AVSampleBufferDisplayLayer。
- **会话限制**：同一台摄像头同时只允许一个 P2P 会话；App 同一 did 复用已有 RemoteStream。不同摄像头可以并存，远程宫格当前用 HashMap 保存多路流；米家 App 占用同一台摄像头时，仍会提示先退出手机直播。

## 5. 验收门禁

| 项目 | 目标 | 当前 |
|---|---|---|
| 单路真画面 | 连续播放 10 分钟 | 两路各自连续运行 10 分 33 秒，画面持续更新 |
| 两路摄像头 | 两路同时出画面，不互相踢下线 | 已同时出画并连续播放 10 分 33 秒：039a01 864×480、069a01 2960×1666 |
| 首帧 | 跨网 15 秒内；超过 30 秒显示可重试错误 | relay 发现优化后 069a01 单路 7.6 秒（开始到 HLS 就绪）；优化前两路 18.76 / 20.27 秒，已达到 15 秒目标 |
| 云台 | 四个方向各按 1 秒，画面有可辨认位移；松手 300ms 内停止 | 069a01 已确认：命令前后画面从客厅左侧切到沙发/冰箱一侧，位移明显；039a01 机型不支持云台，UI 已隐藏方向盘 |
| 内存 | 单路增量 < 120MB，两路 < 220MB | 两路物理内存约 104MB（App 33MB、WebKit GPU 22MB、WebContent 38MB、两个 ffmpeg 共 11MB） |
| CPU | 单路 1080p 解码 < 15% M4 单核 | 两路采样：App 1%、WebKit GPU 2.3%、ffmpeg 0.2% 和 0.0% |
| 失败隔离 | 摄像头进程崩溃不影响设备控制、场景和登录 | 未测 |
| 合规 | 不包含 micam 代码、不依赖 JDK | 构建产物无 Java 进程；仍依赖 ffmpeg |

## 6. 后续

1. 继续采样两路 10 分钟连续播放，确认没有自动断流。
2. 增加 ffmpeg 退出检测和重连；当前只记录帧数，没有把打包器退出映射到 UI。
3. 云台功能已验收；039a01 的云台方向盘已隐藏。后续补四个方向各按 1 秒的固定参照物视频。
4. 决定 ffmpeg 是随 App 打包还是首次启动安装；当前依赖 Homebrew 的 `/opt/homebrew/bin/ffmpeg`。
5. 如果性能门禁不达标，再评估 VideoToolbox 直通，替换 ffmpeg 的 HLS 打包。

## 7. 术语说明

**PPPP**：小米摄像头使用的一套点对点连接协议，包含局域网发现、打洞、relay 中转和自定义消息。

**relay**：厂商的中转服务器。两端不能直连时，数据先发给 relay，再由 relay 转给另一端。

**MISS**：小米摄像头在 PPPP 之上建立的会话协议，负责认证、加密和媒体命令。

**CS2**：较新小米摄像头使用的局域网 P2P 协议；go2rtc 的 `pkg/xiaomi/miss/cs2` 实现的是这一层。

**TUTK**：部分老摄像头使用的 P2P 协议，和 CS2 是并列关系。

**X25519**：一种椭圆曲线密钥交换算法，用来和摄像头协商共享密钥。

**HSalsa20**：NaCl `crypto_box_beforenm` 里把 X25519 共享密钥变成会话密钥的步骤。

**ChaCha20**：一种流加密算法，MISS 用它加密认证后的命令和媒体负载。

**H.265 / HEVC**：一种视频编码格式，压缩率比 H.264 高，macOS 的 VideoToolbox 可以硬件解码。

**HLS**：HTTP Live Streaming，苹果的流媒体格式，WKWebView 和 AVPlayer 可以直接播放。

**fMP4**：分片 MP4，HLS 的一种媒体分片格式，适合 HEVC。

**VideoToolbox**：macOS 的硬件编解码框架，用来把 HEVC 解码交给 GPU/媒体引擎。

**JDK**：Java Development Kit，运行 micam 实验通道所需的 Java 运行环境。
