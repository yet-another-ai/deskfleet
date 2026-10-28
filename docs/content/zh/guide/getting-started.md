# 运行 DeskFleet

打包版本请查看 [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases)。也可以从源码运行当前开发版本。

## 配置开发环境

安装 Git、[mise](https://mise.jdx.dev/) 和带有 Docker Compose 的 Docker。启动 Docker 后执行：

```sh
git clone https://github.com/yet-another-ai/deskfleet.git
cd deskfleet
mise trust
mise install --locked
mise run install
mise run infra:up
mise -E development run dev
```

保留后端进程，在另一个终端启动桌面应用：

```sh
mise run desktop:dev
```

或启动 Web 客户端：

```sh
mise run web:dev
```

Web 客户端地址为 `http://127.0.0.1:5174/`。本地开发账号是 `alice@example.test`，密码为 `password`，仅用于开发环境。

## 添加机器与 Agent

登录并创建团队，在 **添加机器** 中选择当前电脑。桌面应用会注册其内置的机器服务。先在执行机器上安装并登录 Agent CLI，然后在 **设置 → Agent** 中配置。

选择现有目录创建工作区，再创建会话并描述任务。选择 **新建 worktree** 使用独立 Git 工作副本；选择 **工作目录** 直接使用当前目录和未提交改动。

## 无桌面机器

在目标机器上构建并启动独立服务：

```sh
mise run daemon:pack
./apps/daemon/dist/deskfleet-daemon
```

Windows 使用 PowerShell 7，运行 `.\apps\daemon\dist\deskfleet-daemon.exe`。通过服务的 `status` 命令取得机器身份，粘贴到 **添加机器** 对话框，再按照提示导入注册凭证。

支持的构建平台包括 macOS Apple Silicon、Windows x64、Linux x64/arm64。完整命令见仓库中的 [daemon 指南](https://github.com/yet-another-ai/deskfleet/blob/main/apps/daemon/README.md)。

## 远程介入

远程桌面控制是正在开发的首发核心功能。首页直接运行当前的远程桌面界面，使用录制的产品画面作为示例视频流，可以体验连接、断开和全屏操作。安装版本所支持的控制能力与平台范围，请查看对应发布说明。
