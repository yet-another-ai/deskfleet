# 在 Android 上运行（Termux）

你可以在 [Termux](https://termux.dev/)（`proot-distro`）中运行独立的 `linux-arm64` 版 `deskfleet-daemon`，将 Android 手机或平板注册为一台完整的 DeskFleet 机器——运行 Agent、PTY 终端、文件传输，并可选开启原生屏幕投屏与触控/键鼠远控。

## 1. 准备 Termux 环境

1. 从 F-Droid 或 GitHub Releases 安装 **Termux**（如需开机自启可一并安装 **Termux:Boot**）。
2. 在系统设置中将 Termux 的电池策略设为**无限制（Unrestricted）**；Android 14 及以上系统请开启**开发者选项 → 停用子进程限制（Disable child process restrictions）**，避免后台 Agent 进程被系统回收。
3. 获取唤醒锁并安装 `aarch64` Linux 容器：

```sh
termux-wake-lock
pkg update && pkg install proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
```

## 2. 安装并注册 `deskfleet-daemon`

在 Ubuntu 容器内执行：

1. 安装基础证书并解压从 [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) 下载的 `deskfleet-linux-arm64.tar.gz`：
   ```sh
   apt update && apt install -y ca-certificates
   tar -xzf deskfleet-linux-arm64.tar.gz
   ```
2. 启动后台守护进程，并为你的后端地址与团队生成注册信息包：
   ```sh
   ./deskfleet-daemon &
   ./deskfleet-daemon prepare-enrollment --server-url https://your-backend.example --team-id <TEAM_ID>
   ```
3. 在 DeskFleet 桌面端、Web 端或移动端打开 **添加机器 → 其他机器**，粘贴上一步输出并复制签发的凭证 JSON。
4. 在手机容器内通过标准输入导入凭证：
   ```sh
   ./deskfleet-daemon enroll --server-url https://your-backend.example < machine-credentials.json
   ```

## 3. 开启原生屏幕投屏与远控（可选）

如需从 DeskFleet 远程查看并操控手机屏幕，请下载上游 [`scrcpy-server`](https://github.com/Genymobile/scrcpy/releases) JAR（v2.4+ 或 v3.x），通过 `DESKFLEET_ANDROID_SCRCPY_SERVER` 指定路径，并提供 UID 2000（`shell`）通道：

- **无线调试（`adb`）**：在本机开启无线调试并配对连接（`adb connect 127.0.0.1:<端口>`）。
- **Shizuku 或 Root（`DESKFLEET_ANDROID_SHELL`）**：设置 `DESKFLEET_ANDROID_SHELL="rish -c"`（Shizuku）或 `DESKFLEET_ANDROID_SHELL="su -c"`（Root），切到移动数据网络时也不会因 Wi-Fi ADB 断开而中断投屏。

```sh
export DESKFLEET_ANDROID_SCRCPY_SERVER=/root/scrcpy-server-v3.1
# 可选：自定义 shell 通道、ADB 序列号或协议版本号
# export DESKFLEET_ANDROID_SHELL="rish -c"
./deskfleet-daemon
```

## 4. 配置后台常驻与开机自启

配置一次官方服务组件即可免去每次手动启动：

1. 在 Termux 宿主环境（`proot-distro` 外部）安装 `termux-services` 守护进程：
   ```sh
   pkg install termux-services
   mkdir -p "$PREFIX/var/service/deskfleet"
   cat > "$PREFIX/var/service/deskfleet/run" <<'EOF'
   #!/data/data/com.termux/files/usr/bin/sh
   exec proot-distro login ubuntu -- /root/deskfleet-daemon
   EOF
   chmod +x "$PREFIX/var/service/deskfleet/run"
   sv-enable deskfleet
   ```
2. 安装 **Termux:Boot** 后，在 `~/.termux/boot/deskfleet.sh`（赋予 `chmod +x`）中写入 `termux-wake-lock`，手机重启解锁后即可自动在后台拉起服务。
