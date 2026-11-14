# 运行 DeskFleet

你可以将 DeskFleet 作为原生桌面应用运行（在其主进程中内置本地机器 daemon），通过可安装的 Web PWA 访问团队机器，或者在无桌面服务器上部署独立的 `deskfleet-daemon` 可执行文件。

## 安装桌面应用

### macOS（Apple Silicon）

通过官方 Homebrew Tap 安装 DeskFleet：

```sh
brew install --cask yet-another-ai/tap/deskfleet
```

你也可以直接从 [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) 下载 `.dmg` 磁盘映像。

- **Nix（nix-darwin）**：将发布版 flake 添加为输入，应用其 `deskfleet` overlay，并把 `pkgs.deskfleet` 加入 `environment.systemPackages`。nix-darwin 会把已签名的应用包安装到 `/Applications/Nix Apps` 并管理升级。详见 [Nix 分发说明](https://github.com/yet-another-ai/deskfleet/blob/main/agents/docs/ci.md#nix-distribution)。

### Windows（`x64`）

从 [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) 下载并运行 `.exe` 安装程序。

### Linux（`x86_64` 与 `ARM64`）

- **Arch Linux（AUR）**：
  ```sh
  yay -S deskfleet-bin
  ```
- **Nix（启用 flakes）**：将 `<VERSION>` 替换为去掉 `v` 前缀的发布版本号：
  ```sh
  nix profile add 'https://github.com/yet-another-ai/deskfleet/releases/download/v<VERSION>/deskfleet-nix.tar.gz'
  ```
  如果只想临时体验而不加入 profile，可以使用相同 URL 运行 `nix run`。Nix 软件包会安装预构建的桌面应用并连接 DeskFleet 官方服务。
- **Debian / Ubuntu 与 Fedora / RHEL**：从 [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) 下载对应架构的 `.deb`（`amd64` 或 `arm64`）或 `.rpm`（`x86_64` 或 `aarch64`）安装包，然后安装下载的文件。请把示例中的 `<VERSION>` 和架构替换为该发布版本：
  ```sh
  sudo apt install ./deskfleet-<VERSION>-linux-amd64.deb
  sudo dnf install ./deskfleet-<VERSION>-linux-x86_64.rpm
  ```
  由系统包管理器负责升级，这类安装不会使用 AppImage 自动更新。
- **AppImage / 压缩包**：从 [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) 下载对应架构（`x86_64` 或 `arm64`）的 `.AppImage` 或 `.tar.gz` 压缩包。

> [!NOTE]
> 在 Linux Wayland 会话中，远程桌面共享需要当前桌面会话启用 XDG Desktop Portal 与 PipeWire 服务，并配备受支持的 GPU 驱动。

## 注册你的第一台机器

1. 启动 DeskFleet，完成登录，并创建或选择一个**团队（Team）**。
2. 在桌面应用中点击 **添加机器（Add machine）** 并选择 **这台电脑（This computer）**，将桌面应用内置的 daemon 注册到当前团队。
3. 打开该机器的 **设置 → Agent（Settings → Agents）**，安装、验证并登录你常用的 Agent CLI（如 Claude Code、Codex CLI、Cursor CLI 或 Grok CLI）。

关闭桌面窗口后，DeskFleet 仍会常驻系统托盘，正在运行的 Agent 会话、PTY 终端与定时任务会在后台继续执行。需要停止内置 daemon 时，请通过系统托盘菜单退出应用。

## 创建工作区并开始会话

1. 选择一台已注册的机器，添加该电脑上的一个或多个现有目录以创建**工作区（Workspace）**。第一个目录将作为默认工作目录。
2. 创建新**会话（Session）**，选择 Agent 提供方并输入任务描述。
3. 选择代码工作方式：
   - **新建 worktree（New worktree）**：基于已提交的 `HEAD` 创建独立的 Git 工作副本，多个并行会话互不干扰。
   - **工作目录（Working directory）**：直接在工作区的现有目录中操作，包含当前未提交的改动。

## 添加无桌面机器（Headless Machine）

对于没有桌面环境的远程工作站、虚拟机或构建服务器，可以运行独立的 `deskfleet-daemon` 单文件可执行程序（Windows 上为 `deskfleet-daemon.exe`，建议使用 PowerShell 7 `pwsh`）。

1. 从 [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) 下载对应平台的无桌面 daemon 压缩包（`deskfleet-macos-arm64.tar.gz`、`deskfleet-linux-x64.tar.gz`、`deskfleet-linux-arm64.tar.gz` 或 `deskfleet-windows-x64.tar.gz`），或从源码打包：
   ```sh
   mise run daemon:pack
   ```
   从源码构建时，可执行文件位于 `./apps/daemon/dist/deskfleet-daemon`（Windows 上为 `.\apps\daemon\dist\deskfleet-daemon.exe`）。
2. 在目标机器上为你的后端地址与团队生成注册信息包：
   ```sh
   ./deskfleet-daemon prepare-enrollment --server-url https://your-backend.example --team-id <TEAM_ID>
   ```
3. 在桌面客户端或 Web 客户端中打开 **添加机器 → 另一台机器（Add machine → Another machine）**，粘贴上一步输出的注册信息。DeskFleet 会将该机器注册到团队并一次性显示其执行凭证。
4. 在无桌面机器上通过标准输入导入签发的凭证：
   ```sh
   ./deskfleet-daemon enroll --server-url https://your-backend.example < machine-credentials.json
   ```
5. 随时可运行 `./deskfleet-daemon status` 查看已注册的团队状态（不会输出敏感密钥）。完整命令行选项与存储布局请参阅仓库中的 [daemon 指南](https://github.com/yet-another-ai/deskfleet/blob/main/apps/daemon/README.md)；如需在 Android 手机或平板上运行，请参阅 [在 Android 上运行（Termux）](./android)。

## 从源码运行（本地开发栈）

如需从源码在本地运行完整的客户端、daemon 与中心服务端，请先安装 Git、[mise](https://mise.jdx.dev/) 以及带有 Docker Compose 的 Docker。启动 Docker 后执行：

```sh
git clone https://github.com/yet-another-ai/deskfleet.git
cd deskfleet
mise trust
mise install --locked
mise run install
mise run infra:up
mise run dev:seed
mise -E development run dev
```

- **本地基础设施（`infra:up`）**：通过 Docker Compose 启动本地 PostgreSQL、Valkey 与 coturn TURN 服务。
- **预置管理员账号（`dev:seed`）**：在本地开发数据库中创建已验证的站点管理员账号，邮箱为 `admin@deskfleet.test`，密码为 `deskfleet-dev-password`。你也可以在登录页注册新账号，并从 `.local/mail/` 目录中打开验证链接完成注册。
- **API 与 Web 客户端（`dev`）**：在 `http://localhost:8080` 启动 Actix Web 后端，并在 `http://localhost:5174/` 启动 Web 客户端。
- **桌面客户端（`desktop:dev`）**：保持 `dev` 进程运行（Electron 需要本地 Web 服务完成浏览器登录），在另一个终端执行 `mise run desktop:dev`。
