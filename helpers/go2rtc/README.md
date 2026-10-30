# go2rtc

摄像头取流使用 [go2rtc](https://github.com/AlexxIT/go2rtc)，MIT 许可，版本 v1.9.15。

应用不会把二进制提交到仓库。把对应架构的 `go2rtc` 放到本目录，或设置 `MIHOME_GO2RTC`：

```bash
curl -L -o /tmp/go2rtc.zip \
  https://github.com/AlexxIT/go2rtc/releases/download/v1.9.15/go2rtc_mac_arm64.zip
unzip -o /tmp/go2rtc.zip -d helpers/go2rtc
chmod +x helpers/go2rtc/go2rtc
```

macOS Intel 用 `go2rtc_mac_amd64.zip`。应用在启动摄像头时按需拉起子进程，退出时结束它；端口只绑定 `127.0.0.1`。

本地 `cargo run` 从 `helpers/go2rtc` 找二进制；打包后的 DMG 已把 `go2rtc` 放进 `Contents/Resources`，无需另外安装。若要覆盖版本，也可放到用户目录后重启 App：

```bash
mkdir -p ~/Library/Application\ Support/MiHome
cp helpers/go2rtc/go2rtc ~/Library/Application\ Support/MiHome/go2rtc
chmod +x ~/Library/Application\ Support/MiHome/go2rtc
```
