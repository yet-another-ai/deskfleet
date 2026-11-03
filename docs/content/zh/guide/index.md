# 欢迎使用 DeskFleet

DeskFleet 将运行在团队工作站和无桌面服务器上的编程 Agent 汇聚到同一个共享工作空间。在存放代码仓库与工具链的电脑上继续使用你熟悉的 Agent，与团队成员在同一个会话中协同推进任务，并在需要人工介入时随时接管工作环境。

## DeskFleet 的组织结构

DeskFleet 围绕清晰、明确的核心层级来组织资源：

| 概念 | 含义与职责 |
| --- | --- |
| **团队（Team）** | 成员身份、已注册机器、访问权限控制与同步历史记录的共享边界。 |
| **机器（Machine）** | 运行 DeskFleet 桌面应用的工作站（在主进程中托管本地 daemon），或运行独立 `deskfleet-daemon` 可执行文件的无桌面服务器。同一台物理机器可以注册到多个团队，每个团队拥有独立的目录、凭证与会话。 |
| **工作区（Workspace）** | 已注册机器上的一个或多个有序本地目录，第一个目录作为默认工作目录。 |
| **会话与工作树（Session & Worktree）** | 工作区内与 ACP Agent 进行的实时协作会话。每个会话既可以从已提交的 `HEAD` 生成独立的 **Git worktree**，也可以直接在工作区的现有目录中运行。 |

## 核心能力

### 接入你熟悉的 Agent（ACP）

在每台机器上连接已安装并完成认证的 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) Agent——包括 **Codex CLI**、**Claude Code**、**Cursor CLI**、**Grok CLI**、**Oh My Pi**、**DeepSeek Harness** 或自定义 ACP 可执行程序。Agent 直接在所选机器上运行，使用该机器本地的编译器、容器、文件与凭证。

### 多人实时协同

获得授权的团队成员可以从桌面应用或 Web 客户端打开同一个 Agent 会话。共同阅读实时对话、在带作者署名的共享队列中追加后续需求、对正在执行的回合发起即时引导（Steer now），并共同处理工具权限审批请求。

### 通过 WebRTC 随时介入机器环境

当任务需要人工检查、浏览器登录验证或交互式调试时，DeskFleet 通过经过身份认证的 WebRTC（支持自动 TURN 中继回退）将你与目标机器直连：

- **变更面板（Changes）**：在对话旁实时查看已暂存和未暂存的 Git 代码差异。
- **原生 PTY 终端（Terminal）**：打开绑定到机器、工作区或会话 worktree 的持久化原生终端。
- **文件传输（Files）**：通过双栏文件浏览器在本地电脑与任意已注册机器之间上传、下载和管理文件。
- **远程桌面（Desktop）**：在 DeskFleet 中直接查看并控制目标机器的桌面画面。

### 跨机器协同与自动化

每个托管会话都会自动注入内置的 `@deskfleet/mcp` 服务，让 Agent 能够跨已注册机器查询工作区上下文、会话历史与定时计划。你还可以配置周期性运行的**定时任务（Scheduled tasks）**，在 daemon 运行期间自动执行。

## 先动手体验

[首页的交互式演示](/zh/#explore)使用示例数据在浏览器中直接运行真实的 DeskFleet 界面——无需安装或登录，即可切换机器和 Agent、检查代码变更、体验远程桌面连接并参与团队共享会话。

## 从这里开始

- [**运行 DeskFleet**](./getting-started) — 安装桌面应用、注册工作站或无桌面服务器、创建工作区，或启动本地开发栈。
- [**Agent 与多人协作**](./agents) — 配置 ACP Agent、共享会话、管理 Git worktree 与归档恢复、使用终端与文件传输，以及配置定时任务。
- [**隐私与数据承诺**](/zh/privacy) — 了解哪些数据保留在你的机器上、哪些历史用于离线同步查阅，以及我们的零训练承诺。

完整的客户端、机器 daemon 与中心服务端均[以 Apache-2.0 协议开源](https://github.com/yet-another-ai/deskfleet)。
