# go2rtc

摄像头取流使用 [go2rtc](https://github.com/AlexxIT/go2rtc)，MIT 许可，版本 v1.9.15。

应用不会把二进制提交到仓库。使用固定版本下载脚本，脚本会同时校验 ZIP 和 Mach-O 的 SHA256，并准备 Tauri `externalBin` 所需的架构文件名：

```bash
./helpers/go2rtc/fetch.sh
```

也可以显式指定架构：

```bash
./helpers/go2rtc/fetch.sh arm64
./helpers/go2rtc/fetch.sh amd64
./helpers/go2rtc/fetch.sh universal
```

`checksums.txt` 固定了 go2rtc v1.9.15 的官方发布包和二进制哈希。应用启动摄像头前会再次校验 `go2rtc` 的 SHA256；自定义构建需要显式设置 `MIHOME_ALLOW_UNVERIFIED_GO2RTC=1`。

应用在启动摄像头时按需拉起子进程，退出时结束它；端口只绑定 `127.0.0.1`。打包后的 DMG 将经过 SHA256 校验的 sidecar 放在 `Contents/MacOS/go2rtc`，无需另外安装。sidecar 是否带有分发签名取决于构建时是否提供 Developer ID 证书。若要覆盖版本，也可放到用户目录后重启 App：

```bash
mkdir -p ~/Library/Application\ Support/MiHome
cp helpers/go2rtc/go2rtc ~/Library/Application\ Support/MiHome/go2rtc
chmod +x ~/Library/Application\ Support/MiHome/go2rtc
```
