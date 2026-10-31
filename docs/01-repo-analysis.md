# 仓库与协议分析

分析对象：

| 仓库 | 提交 | 日期 | 代码量 | 许可证 |
|---|---|---|---:|---|
| [Do1e/mijia-api](https://github.com/Do1e/mijia-api) | `2cc61f2` | 2026-10-10 | 2,481 行 Python | GPL-3.0 |
| [huanyuejue/MiHome-Windows](https://github.com/huanyuejue/MiHome-Windows) | `5a222c6` | 2026-10-28 | 33,905 行 Python | GPL-3.0 |
| [XiaoMi/ha_xiaomi_home](https://github.com/XiaoMi/ha_xiaomi_home) | `75b3acb` | 2026-09-28 | 18,820 行 Python | 自定义许可证，仅限 Home Assistant 非商业使用 |

`ha_xiaomi_home` 不在交付目标里，只用来核对云端 MQTT 与局域网协议。它的许可证明确禁止用于开发 App，代码不能复制。

本文把结论分成三类证据：

- **已实测**：本机发过请求或跑过代码，有输出。
- **代码可证**：仓库源码里能直接读到实现，但没有连真实设备验证。
- **待实测**：需要真实米家账号和设备才能确认。

## 一、先给结论

1. **macOS 客户端可以做。** 登录、家庭、房间、设备列表、属性读写、场景执行都有现成接口。二维码登录端点在 2026-10-29 实测可达，返回了有效二维码链接。
2. **不能把现有代码直接搬进闭源 Mac App。** 两个主仓库都是 GPL-3.0，分发修改版本需要开放源代码。`ha_xiaomi_home` 的许可证更严，只允许在 Home Assistant 内非商业使用。
3. **性能不是主要障碍。** 120 台设备、1.7 MB 的极端协议数据，Swift 解码 23.77 ms、核心常驻内存 14.9 MB。真实瓶颈是设备型号差异、轮询次数、局域网 Token 和云端限流。
4. **现成 Windows 客户端的设计可以借鉴，代码需要重写。** 它的服务分层、批量读取、优先级队列、乐观更新和版本号防回滚都值得保留；Qt 控件体系、Windows 专有窗口代码和同步阻塞模型不适合 Mac。
5. **最稳的产品路线是先做云端只读与开关控制，再做局域网直连和复杂设备面板。** 局域网控制依赖 `xiaomiio` 域的 `token` 与 `localip`，和米家 App 域不是同一套登录结果。
6. **摄像头实时查看能力不在两个仓库里，但可以作为独立模块做进第一版。** 两个仓库只把摄像头当普通设备或托盘状态，不处理视频流。可选的 MIT 许可方案是 go2rtc，它支持部分小米 CS2/TUTK 机型，走局域网 P2P，输出 HLS/MP4/RTSP/WebRTC；代价是新增一个本机 helper 进程，且只能覆盖兼容机型。

## 二、mijia-api

### 2.1 它解决什么问题

`mijia-api` 用 Python 封装米家 App 的 HTTP 接口，提供三种入口：

- Python 库：`mijiaAPI` 负责登录与请求，`mijiaDevice` 负责单台设备的属性读写。
- 命令行：`mijiaAPI login`、`mijiaAPI -l`、`mijiaAPI set --dev_name ...`。
- MCP Server：把设备列表、属性读写和场景执行暴露给支持 MCP 的客户端。

许可证 GPL-3.0，要求 Python 3.10 以上。

### 2.2 模块分工

| 文件 | 行数 | 职责 |
|---|---:|---|
| `mijiaAPI/apis.py` | 848 | 登录、Token 刷新、请求签名、家庭、设备、场景、耗材、属性、动作、统计 |
| `mijiaAPI/__main__.py` | 564 | 命令行接口 |
| `mijiaAPI/mcp_server.py` | 434 | MCP Server |
| `mijiaAPI/devices.py` | 390 | MIoT-Spec 拉取、设备属性与动作包装、动态属性访问 |
| `mijiaAPI/errors.py` | 83 | 错误码与异常类型 |
| `mijiaAPI/miutils.py` | 81 | nonce、签名、RC4 加解密 |
| `mijiaAPI/logger.py` | 49 | 日志 |
| `mijiaAPI/__init__.py` | 31 | 导出 |

结构集中：`mijiaAPI` 一个类同时管认证、签名、HTTP 会话和业务接口，848 行。对脚本够用；移植到 Mac 时应拆成认证、传输、业务三层。

### 2.3 登录与凭据

登录走小米账号的二维码流程，不存明文密码。

```
GET https://account.xiaomi.com/longPolling/loginUrl?_json=true&sid=mijia&_locale=zh_CN
  -> loginUrl / qr / lp / timeOut
用户在米家 App 扫码确认
轮询 lp 地址
  -> 跳转 location，写入 Cookie
  -> 保存 serviceToken、passToken、userId、cUserId、ssecurity
```

凭据默认写到 `~/.config/mijia-api/auth.json`，字段包括 `ua`、`ssecurity`、`userId`、`cUserId`、`serviceToken`、`passToken`、`expireTime`。`passToken` 约 30 天有效；`serviceToken` 过期前自动刷新。

`sid` 可以换成 `xiaomiio`。本次实测两个 `sid` 都返回了有效二维码链接：

```
GET .../longPolling/loginUrl?_json=true&sid=xiaomiio&_locale=zh_CN
HTTP 200，内容以 &&&START&&& 开头，含 loginUrl、qr、lp、timeOut=300
```

这只能证明端点可用，没有完成真实扫码。

### 2.4 请求签名

每次业务请求都会重新生成 nonce，并对参数做 RC4 加密与 SHA1 签名。核心步骤：

1. 请求体是紧凑 JSON：`{"data": "..."}`。
2. 生成 nonce；`signed_nonce = SHA256(base64(ssecurity) + base64(nonce))`。
3. 用 `signed_nonce` 派生 RC4 密钥，加密参数。
4. 对加密后的参数做 SHA1，得到 `rc4_hash__`。
5. 再拼 `signature`，以表单 POST 到 `https://api.mijia.tech/app` + URI。
6. 响应可能是明文 JSON，也可能是 RC4 密文；密文用同一组 `ssecurity` 与 nonce 解密。

请求头里有两个容易漏掉的点：

- `miot-encrypt-algorithm: ENCRYPT-RC4`
- `x-xiaomi-protocal-flag-cli: PROTOCAL-HTTP2`，这里的 `protocal` 是服务端要求的拼写，不能改成 `protocol`。

Cookie 里带 `serviceToken`、`cUserId`、`PassportDeviceId`、`timezone`、`locale`、`channel=MI_APP_STORE`。`User-Agent` 由客户端随机生成并保存在 `auth.json` 的 `ua` 字段，格式伪装成米家 Android 客户端。

### 2.5 业务接口

| 能力 | 方法 | 服务端 URI |
|---|---|---|
| 家庭列表 | `get_homes_list()` | `/home/homelist` |
| 设备列表 | `get_devices_list(home_id)` | `/home/home_device_list`，分页 200 |
| 共享设备 | `get_shared_devices_list()` | `/home/shared_device_list` |
| 手动场景 | `get_scenes_list(home_id)` | `/home/scene_list` |
| 执行场景 | `run_scene(scene_id, home_id)` | `/home/scene_run` |
| 耗材 | `get_consumable_items(home_id)` | `/home/consumable_items` |
| 读属性 | `get_devices_prop(data)` | `/miotspec/prop/get` |
| 写属性 | `set_devices_prop(data)` | `/miotspec/prop/set` |
| 执行动作 | `run_action(data)` | `/miotspec/action` |
| 统计 | `get_statistics(data)` | `/v2/user/statistics` |

读属性、写属性都接受单个对象或列表，列表就是批量请求。`mijiaAPI` 自己不做 20 条上限，上限来自网关和实际测试；`MiHome-Windows` 把 20 作为安全批量。

场景只能列出和执行，不能创建、修改、删除。统计接口只对部分型号有效，`key` 与 `data_type` 因设备而异，不是通用时间序列接口。

### 2.6 设备规格与动态控制

`mijiaDevice` 的工作方式：

1. 从设备列表拿到 `spec_type`，例如 `urn:miot-spec-v2:device:light:0000A001:yeelink-lamp4:1`。
2. 请求 `https://miot-spec.org/miot-spec-v2/instance?type=<spec_type>`。
3. 把规格 JSON 缓存到认证文件同目录，文件名把冒号换成下划线。
4. 遍历 `properties` 和 `actions`，生成 `prop_list` 与 `action_list`。
5. 通过 `__setattr__` 拦截属性赋值，把 `device.brightness = 60` 转成 `/miotspec/prop/set`。

这套做法让未知型号也能生成基础控件：布尔属性做开关，数值属性做滑块，枚举属性做下拉框，动作做按钮。

三个限制：

- 构造一个 `mijiaDevice` 要发两次请求：设备列表与 spec。批量创建设备对象时会造成 N+1。
- 没有公开 `spec_type` 的设备无法控制，常见于手表、纯蓝牙设备和部分第三方产品。
- 上游单属性读写默认每次 `sleep 0.5` 秒防限流；详情页十几项属性逐个读要等近十秒。`MiHome-Windows` 用批量读取绕开了这个问题。

### 2.7 这个仓库值得保留的部分

- 登录、签名、错误码的实现可以直接当协议参考。
- 规格缓存与动态属性映射的思路适合 Mac 版。
- 命令行与 MCP 说明接口边界清楚，便于做自动化测试。
- 错误码表覆盖了常见云端失败，可以作为 Mac 版错误文案的底稿。

### 2.8 移植时不建议照搬的部分

- 一个 848 行的类同时管认证、签名和业务，测试和替换都困难。
- 同步 `requests` 与 `sleep` 不适合 GUI；Mac 版应全部改成 async/await。
- 凭据存明文 JSON；Mac 版应放 Keychain。
- 每个设备对象重新拉设备列表；Mac 版应在启动时建索引，按 `spec_type` 缓存规格。
- 没有局域网传输与状态推送；需要单独实现。

## 三、MiHome-Windows

### 3.1 代码结构

| 目录 | 行数 | 职责 |
|---|---:|---|
| `app/core` | 3,328 | 服务层、任务队列、缓存、模型、定时与诊断 |
| `app/ui` | 16,382 | 主窗口、设备卡片、工作台、挂件、托盘、设置 |
| `app/siui` | 13,951 | 自绘控件库，按钮、滑块、菜单、输入框等 |
| 其他 | 244 | 入口、测试、工具脚本 |

最大的几个文件：

| 文件 | 行数 | 说明 |
|---|---:|---|
| `app/siui/components/button.py` | 2,623 | 自绘按钮 |
| `app/ui/main_window.py` | 2,457 | 主窗口与轮询 |
| `app/ui/widgets_board.py` | 2,190 | 桌面挂件 |
| `app/siui/components/slider_.py` | 1,506 | 自绘滑块 |
| `app/core/service.py` | 1,218 | 米家服务封装 |
| `app/ui/workbench_panel.py` | 1,055 | 设备工作台 |

这是一个 Windows 应用，窗口装饰、托盘、注册表自启动、字体、图标和 DPI 处理都绑定 Windows。macOS 版无法复用界面层。

### 3.2 分层

```
app/ui           PySide6 窗口、卡片、托盘、挂件
    |
app/core         MijiaService、JobExecutor、缓存、定时任务
    |
mijiaAPI         HTTP 登录、签名、设备属性
```

`MijiaService` 是唯一接触 `mijiaAPI` 的层，界面只传 `did`、属性名和值。这个边界设计合理，Mac 版可以保留同样的分层，把实现换成 Swift。

`JobExecutor` 把所有米家网络调用排进一个后台线程，按优先级出队：

- `PRIORITY_CONTROL = 0`：用户开关、动作、语音。
- `PRIORITY_DATA = 1`：轮询与读数。
- `PRIORITY_IDLE = 2`：图标、产品页名称、版本检查。

结果只放进线程安全队列，由主线程每 16 ms 取走执行回调，不跨线程发 Qt 信号。这是 Windows 版避免崩溃的工程选择。

### 3.3 设备列表与控制

`list_devices()` 先拉家庭、设备、共享设备，再用每个家庭的 `roomlist[].dids[]` 反查设备属于哪个房间。设备接口本身不带房间字段，这一点 Mac 版也要照做。

`device_detail()` 从规格生成控件：

- 布尔属性 → 开关
- 整数/浮点属性 → 滑块，套用 `valueRange` 的 min/max/step
- 枚举属性 → 下拉框，显示 `value-list` 的中文描述
- 动作 → 按钮，执行前确认
- 无 `spec_type` 的设备 → 明确提示“无公开功能规格”，不给空面板

`power_states()` 是性能上最关键的方法。它做了三段压缩：

1. `did -> model/spec_type` 索引增量补齐，避免每次拉设备列表。
2. 规格用 8 个线程并发拉取，命中本地缓存后零网络开销。
3. 属性按 20 条一批读取。

虚拟多键开关（`<父did>.sN`）在云端只认父 `did` 加对应 `siid`，直接拿子 `did` 请求会返回 `-704083036`。Windows 版第一次失败后记住映射，后续直接发父 `did`。

`read_props()` 把详情面板的十几个属性合并成一次批量请求。上游逐个读会 `sleep 0.5` 秒，批量后整面板一次往返完成。

### 3.4 轮询

| 参数 | 值 | 位置 |
|---|---:|---|
| 开关状态轮询 | 3,000 ms | `app/ui/main_window.py:71` |
| 温湿度等读数 | 300,000 ms（5 分钟） | `_METRICS_INTERVAL_MS` |
| 单次属性批量 | 20 条 | `app/core/service.py:50` |
| 规格并发 | 8 个线程 | `app/core/service.py:58` |
| 定时任务检查 | 独立 QTimer | `_schedule_timer` |

轮询只覆盖当前可见且在线的设备，加上桌面挂件里跟踪的设备。离线设备会被跳过，因为云端返回的是最后一次在线缓存，不可信。

轮询结果写回前会比较 `_power_gen` 操作版本号。用户在请求在途时点了开关，旧结果会被丢弃，避免按钮“绿一下又变灰”。

### 3.5 界面性能问题

Windows 版有三处明显的界面开销：

1. **房间切换重建整个网格。** `_rebuild_grid()` 销毁所有 `DeviceCard`，再按当前房间重新创建。每张卡片都要重新查图标文件、重新绑定信号。设备多时切换房间会顿一下。
2. **窗口缩放也会重建。** `resizeEvent` 有 60 ms 防抖，但拖动窗口结束后仍会全部重建。
3. **卡片没有虚拟化。** 所有可见设备一次性创建 QWidget。11 台设备没问题；120 台时控件树、图标解码和布局都会变重。

Mac 版应改成数据驱动列表：`LazyVStack` 或 `NSTableView` 复用行，房间切换只换数据源，窗口缩放只重排布局。

### 3.6 值得借鉴的交互

- 设备卡片直接放开关、亮度、温度步进，不强迫用户进详情页。
- 场景作为独立标签页，不混在设备里。
- 桌面挂件与托盘快捷面板分开配置，互不影响。
- 顶部环境胶囊显示温度、湿度、开启设备数、耗材不足数，点开看明细。
- 自定义设备名只存本地，带“自定义”标记，可一键恢复云端名。
- 设备无公开规格、离线、属性不支持时给出具体原因，不显示空白控件。
- 定时任务要明确告知“应用需保持运行，错过不补执行”。

这些规则已经写进原型。

## 四、协议与请求路径

### 4.1 域名与用途

| 域名 | 用途 | 是否需要登录 |
|---|---|---|
| `account.xiaomi.com` | 二维码登录、Token 刷新 | 否 |
| `api.mijia.tech/app` | 家庭、设备、场景、耗材、属性、动作、统计 | 是 |
| `api.io.mi.com/app` | `xiaomiio` 域的 `device_list`，返回设备 `token` 与 `localip` | 是，`sid=xiaomiio` |
| `miot-spec.org` | 按 `spec_type` 拉设备规格 JSON | 否 |

`mijia-api` 的 `_request()` 把所有业务 URI 都发到 `api.mijia.tech/app`，包括 `/miotspec/prop/get` 与 `/miotspec/prop/set`。`api.io.mi.com` 只在需要设备 Token 时使用，不能把两者混为一谈。

### 4.2 首次登录到设备列表

```
1. GET loginUrl (sid=mijia)              -> qr / lp / timeOut
2. 用户扫码，轮询 lp                      -> location
3. GET location，收 Cookie               -> serviceToken / passToken / ssecurity
4. POST /home/homelist                    -> 家庭列表，含 roomlist[].dids[]
5. POST /home/home_device_list            -> 设备列表，含 did/model/spec_type/isOnline
6. POST /home/shared_device_list          -> 共享设备
7. GET miot-spec.org/instance?type=...    -> 规格 JSON，按 spec_type 缓存
8. POST /miotspec/prop/get                -> 开关、亮度、温度等当前值
```

第 4、5 步的 `roomlist[].dids[]` 是房间归属的唯一来源。设备对象本身没有 `room_id`。

### 4.3 控制

写属性：

```json
[
  {"did": "123", "siid": 2, "piid": 2, "value": 60},
  {"did": "123", "siid": 2, "piid": 3, "value": 4200}
]
```

动作：

```json
{"did": "123", "siid": 2, "aiid": 1, "value": []}
```

批量上限以 20 条为安全值。一次请求的往返在 Windows 版的注释里记为 150–600 ms；本次本机请求 `api.mijia.tech` 的 TTFB 是 119–209 ms，未带登录态，只能作为网络下限参考。

### 4.4 局域网控制

局域网控制与云端是两套协议。

前置条件：

- 设备是支持 MIoT-Spec v2 的 Wi-Fi 设备。
- 从 `xiaomiio` 域的 `/home/device_list` 拿到 `token` 和 `localip`。
- Mac 与设备在同一局域网，没有 AP 隔离或跨 VLAN。

数据包：

- UDP 端口 54321。
- 32 字节头，含 magic、长度、时间戳、MD5 校验。
- 负载用 AES-128-CBC 加密，PKCS#7 填充。
- 密钥 `key = MD5(token)`，初始向量 `iv = MD5(key + token)`。
- 加密后把 token 写入头部固定位置，再计算 MD5。

`ha_xiaomi_home` 的 `miot_lan.py` 实现了握手、属性读写、动作和通配订阅。它只支持 MIoT-Spec v2 的 Wi-Fi 设备，不支持纯蓝牙、Zigbee 子设备直连和第三方私有协议。Zigbee 子设备要通过网关，请求仍然发给父设备。

局域网控制的优点：

- 延迟通常 10–50 ms，比云端稳定。
- 不经过小米云，断网时仍可用。
- 可以订阅属性变化，减少轮询。

限制：

- `token` 不在米家 App 域的登录结果里，要额外登录 `xiaomiio` 域。
- `localip` 会随 DHCP 变化，需要在每次启动或网络切换后刷新。
- Mac 第一次访问局域网会弹系统权限；沙盒、组播权限、防火墙都可能拦截。
- 设备固件升级后协议可能变化。

### 4.5 状态推送

`mijia-api` 没有设备状态回调，只有轮询。`ha_xiaomi_home` 用云端 MQTT（MIPS）订阅属性变化，但它的许可证不允许把实现用于 App。

可选路线：

1. 只做轮询：实现简单，云端压力大，状态延迟 3–10 秒。
2. 自己做 MQTT：需要 `app_id`、`access token`、区域 broker 和主题格式；协议未公开，升级风险高。
3. 局域网订阅：设备支持时最稳，只能覆盖同一局域网内的 Wi-Fi 设备。

Mac 版第一版用自适应轮询；局域网订阅作为第二阶段。

## 五、能力边界

| 能力 | 云端接口 | 局域网 | 结论 | 限制 |
|---|---|---|---|---|
| 扫码登录 | 有 | 不需要 | 可做 | 非官方接口，可能触发风控 |
| 家庭、房间 | 有 | 不需要 | 可做 | 房间归属要自己从 `roomlist` 反查 |
| 设备列表 | 有 | 不需要 | 可做 | 无 `spec_type` 的设备无法控制 |
| 开关、亮度、色温、温度 | 有 | 有 | 可做 | 型号差异大，要按规格生成控件 |
| 传感器读数 | 有 | 有 | 可做 | 只能读当前值 |
| 历史曲线 | 部分 | 无 | 有限 | `get_statistics` 只覆盖部分型号与指标 |
| 手动场景 | 列出、执行 | 无 | 可做 | 不能创建、修改、删除 |
| 自动化 | 无 | 无 | 只能本地定时 | App 需常驻，错过不补 |
| 扫地机地图 | 无 | 部分 | 不做 | 私有协议，工作量大 |
| 摄像头 | 无 | 无 | 第一版做，独立模块 | 需要 P2P 与解码；只覆盖兼容机型，必须同局域网 |
| 固件升级 | 无 | 无 | 不做 | 风险高 |
| 共享设备 | 有 | 部分 | 可做 | 部分属性只读 |
| 状态推送 | 无 | 可订阅 | 第二阶段 | 需要局域网 Token |
| 菜单栏、小组件 | 本机能力 | 不涉及 | 可做 | 用 AppKit、WidgetKit |
| 多账号 | 可做 | 可做 | 暂不做 | 凭据与数据要隔离 |

### 5.1 摄像头：两个仓库都没有，但可以单独接

先把事实分开：

- `mijia-api` 没有摄像头相关代码、接口或解码逻辑。它的定位是设备属性与场景，不处理音视频。
- `MiHome-Windows` 也没有实时画面。它的设备服务把摄像头归入“没有开关能力”的设备，托盘状态只显示在线与否；代码里没有任何 RTP、HLS、P2P 或解码实现。
- 米家摄像头的实时流不走普通 MIoT 属性。部分机型的 MIoT 规格里有 `start-rtsp-stream`、`start-hls-stream`、`start-p2p-stream` 动作，但能否成功取决于机型、账号权限和固件，不能当成通用 RTSP 地址使用。

可落地的路线是引入一个本机取流助手。当前最合适的是 [go2rtc](https://github.com/AlexxIT/go2rtc)：

| 项目 | 事实 |
|---|---|
| 许可 | MIT，可随闭源 App 分发，保留版权声明 |
| 版本 | 1.9.15，2026-10-25 发布 |
| macOS 产物 | `go2rtc_mac_arm64.zip` 7.4 MB；`amd64` 8.1 MB |
| 小米支持 | `xiaomi/mess` 与 `xiaomi/legacy`，支持 CS2/TUTK 的 UDP/TCP 变体 |
| 登录 | `xiaomi: <userID>: <passToken>`；源码里的 `LoginWithToken` 直接用 `userId` 与 `passToken` Cookie 换取 `ssecurity` |
| 输出 | HLS、MP4、RTSP、WebRTC；本机默认端口 1984/8554/8555 |
| 限制 | 必须与摄像头同一局域网；首次连接需要联网取密钥；不是所有型号都兼容；部分老机型没有双向音频 |

这条路线和本项目的扫码登录能接上：扫码拿到的 `passToken` 与 `userID` 可以直接交给 go2rtc，不需要再让用户输入小米密码或短信验证码。App 负责登录、设备列表和 UI；helper 只负责 P2P 取流与格式转换。helper 绑定 `127.0.0.1`，由 App 启动和回收，不暴露到局域网。

不建议选 MiBeeNvr：它能覆盖 C200/C300 等机型，但许可证是 AGPL-3.0，闭源分发风险高。micam 依赖 Java 21 运行时，包体和启动成本都不适合桌面端。

结论：摄像头是可控的独立工程，不是两个仓库的现成能力。第一版应把它作为单独模块排期，先验证用户手上的具体型号，再承诺机型覆盖。

## 六、性能分析

### 6.1 请求数量

首次启动、11 台设备、5 种规格的估算：

| 阶段 | 请求数 | 说明 |
|---|---:|---|
| 登录 | 0（已登录） | Token 有效时跳过 |
| 家庭 | 1 | `/home/homelist` |
| 设备 | 1 | `/home/home_device_list`，200 条/页 |
| 共享设备 | 1 | `/home/shared_device_list` |
| 规格 | 5 | 按 `spec_type` 去重，可并发 |
| 当前状态 | 1 | 11 台设备、每台 1 条开关属性，20 条/批 |
| 合计 | 9 | 不含图标与产品页名称 |

120 台设备、每台 40 条属性的极端情况：

- 设备列表 1 次，规格按型号去重后可能十几次，属性 240 批。
- 1.7 MB 只是属性数据的极端上界；11 台设备的常规数据约 160 KB。
- 真正需要优化的是“每个设备对象构造两次请求”的 N+1，不是 JSON 解码。

### 6.2 轮询成本

11 台设备、每批 20 条：

- 每 3 秒 1 次属性请求。
- 每次 150–600 ms，占空比 5%–20%。

120 台设备：

- 每轮 6 次属性请求。
- 单线程串行需要 0.9–3.6 秒；3 秒周期会排满，用户操作要排在轮询后面。
- 云端限流风险随设备数上升。

Mac 版应采用：

- 前台 3–5 秒，后台 15–30 秒，窗口隐藏后降到 60 秒。
- 只轮询当前可见设备与菜单栏/小组件跟踪的设备。
- 单设备写入优先，轮询请求可取消。
- 合并同一设备的连续写入，滑块拖动只在松手时提交。
- 失败退避：1、2、4、8、30 秒，成功一次后复位。

### 6.3 界面开销

Windows 版的三处开销在 Mac 版要避开：

| 问题 | Windows 版做法 | Mac 版做法 |
|---|---|---|
| 房间切换 | 销毁并重建全部卡片 | 只换数据源，列表复用行 |
| 窗口缩放 | 防抖后重建网格 | 布局自动重排，不重建视图 |
| 设备很多 | 所有卡片一次性创建 | `LazyVStack` / `NSTableView` 虚拟化 |
| 图标 | 每张卡片查文件、异步下载 | 内存图片缓存 + 磁盘缓存，按型号去重 |
| 轮询写回 | 版本号防旧值覆盖 | 同一套 generation 机制，放在 actor 里 |

### 6.4 本机微基准

机器：Apple M4、32 GB、macOS 26.6.2。数据：120 台设备 × 40 条属性，1,743.9 KiB。JSON 每轮 30 次取中位数，AES 每轮 3,000 次取中位数。

| 运行时 | 进程启动 (ms) | 最快 (ms) | JSON 解码 (ms) | AES-128-CBC 1 KiB (µs) | 峰值内存 (MB) |
|---|---:|---:|---:|---:|---:|
| Swift 6.2 | 25.9 | 24.9 | 23.77 | 0.37 | 14.9 |
| Rust 1.86 | 3.8 | 3.6 | 1.70 | 3.29 | 3.9 |
| Node 24 | 36.1 | 35.8 | 3.73 | 7.80 | 64.9 |
| Python 3.9 | 32.1 | 31.3 | 10.19 | 7.44 | 23.3 |

读法：

- 启动时间包含运行时初始化、读取 1.7 MB 文件、解码一次。
- Swift 的 `JSONDecoder` 解码到强类型模型，比 Rust 的 `serde` 慢；1.7 MB 是最坏情况，常规 160 KB 约 2–3 ms。
- AES 这一列每次新建 cipher 上下文，包含密钥扩展；Rust 在这个口径下反而慢，不能当成批量加解密的吞吐结论。
- 峰值内存只是协议进程，不含 GUI 框架、窗口、图片和字体。Electron 的实际应用内存会远高于 64.9 MB。
- 这组数字不能直接推断 GUI 启动时间。

结论：Swift 的协议层足够快。把 Rust 放进第一版会增加 FFI、构建和调试成本，收益在这个数据规模下不明显。

## 七、许可证与合规

### 7.1 三个仓库的许可证

| 仓库 | 许可证 | 对 Mac App 的影响 |
|---|---|---|
| `mijia-api` | GPL-3.0 | 复制或修改代码并分发，需要按 GPL 开放源代码 |
| `MiHome-Windows` | GPL-3.0 | 同上；界面层也无法直接用于闭源产品 |
| `ha_xiaomi_home` | 小米自定义许可证 | 只允许在 Home Assistant 内非商业使用，明确禁止开发 App、Web 服务 |

### 7.2 三条可选路线

1. **开源 GPL 客户端。** 可以移植 `mijia-api` 的代码，按 GPL-3.0 发布。代价是竞争对手可以复用，Mac App Store 也可能因 DRM 条款与 GPL 冲突而无法上架。
2. **闭源商业客户端。** 按协议重新实现，不复制 GPL 代码。协议事实、字段名、错误码不受版权保护；代码结构、注释、函数实现不能照搬。需要法务确认。
3. **内部工具。** 不分发，只在自己机器上跑，GPL 的分发义务不触发。仍要遵守小米的服务条款与商标规则。

### 7.3 商标

小米的许可证明确限制使用“小米”“米家”等字样做宣传。公开分发时，产品名、图标、文案都要避免让用户误以为这是小米官方产品。原型内部使用“MiHome Mac”只作演示，正式发布前要改名并做商标检索。

### 7.4 账号与数据

- 二维码登录等价于把米家账号的访问权交给本机应用；Token 泄露可以控制全部设备。
- 凭据必须放 Keychain，不能写日志、不能放 UserDefaults、不能进崩溃报告。
- 诊断日志只记录设备 ID 的哈希、请求耗时、错误码，不记录 Token、Cookie、完整响应。
- 云端接口没有官方 SLA，账号被风控或接口变更时要有降级方案。

## 八、复用判断

| 内容 | 是否复用 | 说明 |
|---|---|---|
| 二维码登录流程 | 参考实现，重写 | 端点、参数、Cookie 字段可照协议实现 |
| RC4 签名 | 参考实现，重写 | Swift 需要自己实现 RC4 与 SHA1 组合 |
| MIoT-Spec 解析 | 参考实现，重写 | 规格 JSON 是公开数据，字段结构可复用 |
| 设备列表与房间映射 | 参考实现，重写 | `roomlist[].dids[]` 反查逻辑要保留 |
| 批量属性读写 | 保留设计 | 20 条一批，按 `siid/piid` 对应响应 |
| 父设备 `did` 处理 | 保留设计 | 多键开关必须走父 `did` |
| 优先级队列 | 保留设计 | Mac 版用 actor 与任务优先级替代 |
| 乐观更新与版本号 | 保留设计 | 防止在途轮询覆盖用户操作 |
| Qt 界面 | 不复用 | Windows 专有，Mac 重写 |
| Nuitka 打包 | 不复用 | Mac 用 Xcode + 签名 + 公证 |
| 应用配置、缓存结构 | 参考 | 字段可以沿用，存储换 SQLite/Keychain |
| 局域网协议 | 参考 `ha_xiaomi_home` | 只读协议事实，不复制代码 |

## 九、还没验证的部分

| 项目 | 现状 | 验证方式 |
|---|---|---|
| 真实扫码登录 | 只验证端点返回二维码 | 用测试账号完整扫一次，检查 Token 刷新与过期 |
| 设备属性读写 | 只读源码与公开文档 | 选 5 类设备：灯、空调、窗帘、净化器、插座 |
| 批量 20 条上限 | 来自 Windows 版实测注释 | 用 1/10/20/50 条逐档压测，记录错误码与耗时 |
| 局域网 Token | 只读协议实现 | 用 `sid=xiaomiio` 登录，取 `token`/`localip`，发 UDP 握手 |
| 局域网加密 | 只读 `ha_xiaomi_home` | 用已知 Token 解密一帧，核对 MD5 与 PKCS#7 |
| 多键开关父 `did` | 来自 Windows 版注释 | 用三键开关验证 `siid` 与父 `did` 组合 |
| 设备状态推送 | 未实现 | 先做局域网订阅；云端 MQTT 需要额外授权 |
| 统计接口 | 只读文档 | 用空调伴侣与插座验证 `key` 与 `data_type` |
| 限流阈值 | 未知 | 逐档提高轮询频率，记录 429/错误码与恢复时间 |
