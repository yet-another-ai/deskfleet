---
title: 隐私与数据承诺
description: DeskFleet 前后端完全开源。官方服务不会使用你的工作数据训练模型。
---

# 你的工作数据，不用于训练

**DeskFleet 官方服务绝不会使用你的代码、对话或工作记录来训练模型。**

## 从客户端到服务端，完整开源

[DeskFleet 的完整源码](https://github.com/yet-another-ai/deskfleet)——包括 Electron 桌面应用、Vue Web PWA、TypeScript 机器 daemon、Actix Web + PostgreSQL 中心控制面服务端，以及 Rust 原生底层库——全部以 [Apache-2.0 协议](https://github.com/yet-another-ai/deskfleet/blob/main/LICENSE)开源。你可以审查每一个凭证、每一条消息和每一路数据流的处理方式，也可以在自有基础设施上完整自托管后端与 TURN 中继服务。

## 数据保存在哪里

DeskFleet 将机器本地执行与团队中心协同严格分离，确保你的开发环境与敏感凭证始终留在执行工作的电脑上：

| 数据或流量类型 | 存储或传输位置 | 说明 |
| --- | --- | --- |
| **代码仓库、Git worktree 与未提交文件** | 仅保存在已注册的执行机器上 | Agent 直接在你的本地文件系统中读写和运行代码。 |
| **Agent CLI 登录凭证与自定义 MCP 密钥** | 仅保存在已注册的执行机器上 | 存储在机器本地配置（`agent-providers.json`、`mcp-servers.json`）中，绝不上传至中心服务端。 |
| **完整 PTY 终端输出记录** | 仅保存在已注册的执行机器上 | 保存在 daemon 本地目录（`terminals/`）中，确保客户端重连时终端会话持久不断开。 |
| **账号、团队成员、角色与机器注册信息** | 中心 PostgreSQL 服务端 | 用于验证团队成员身份、执行访问授权并路由信令。 |
| **工作区目录与对话/工具历史副本** | 机器本地 SQLite + 中心 PostgreSQL 同步副本 | 支持团队成员共享会话协作，并在笔记本合盖或构建机离线时继续查阅历史对话与工具输出。 |
| **实时 Agent 交互、Git diff、终端 I/O、文件传输与远程桌面视频** | 点对点 WebRTC（支持 TURN 中继回退） | 在经过认证的客户端与机器 daemon 之间直接传输。远程桌面视频流与传输的文件绝不会作为会话历史存储。 |

## 你接入的 Agent 与模型提供方

当你在已注册机器上运行 Codex CLI、Claude Code、Cursor CLI、Grok CLI、Oh My Pi、DeepSeek Harness 或其他 ACP Agent 时，Agent 会使用你在该机器上配置的账号和凭证直接与其模型提供方通信。各模型提供方有各自的服务条款、隐私政策和数据保留设置。DeskFleet 的数据承诺适用于 DeskFleet 官方服务，不改变第三方模型提供方处理其请求的方式。

## 网站交互式演示

本网站首页的交互式工作区示例完全在你的浏览器本地内存中运行，使用预置的演示数据。它们不会连接真实后端、不会启动 Agent、不会执行 shell 命令，也不会访问你的电脑。刷新页面即可重置所有演示状态。
