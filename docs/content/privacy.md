---
title: Privacy and our data promise
description: The complete DeskFleet client and server are open source. The official service will not use your work data to train models.
---

# Your work is not training data

**The official DeskFleet service will not use your code, conversations, or work records to train models.**

## Open from client to server

The complete [DeskFleet source code](https://github.com/yet-another-ai/deskfleet)—including the Electron desktop app, Vue Web PWA, TypeScript machine daemon, Actix Web + PostgreSQL control-plane server, and Rust native libraries—is open source under the [Apache-2.0 License](https://github.com/yet-another-ai/deskfleet/blob/main/LICENSE). You can inspect how every credential, message, and stream moves through the system, or self-host the entire backend and TURN relay on your own infrastructure.

## Where your data lives

DeskFleet separates local machine execution from central team coordination so your environment and credentials stay on the computers doing the work:

| Data or traffic | Where it lives | Why |
| --- | --- | --- |
| **Repositories, Git worktrees & uncommitted files** | Enrolled machine only | Agents edit and run code directly in your local filesystem. |
| **Agent CLI credentials & custom MCP secrets** | Enrolled machine only | Stored in local machine configuration (`agent-providers.json`, `mcp-servers.json`) and never uploaded to the central server. |
| **Full PTY terminal transcripts** | Enrolled machine only | Retained in the daemon's local storage (`terminals/`) so shells persist across client reconnects. |
| **Accounts, teams, roles & machine registrations** | Central PostgreSQL server | Authenticates team members, enforces access grants, and routes signaling. |
| **Workspace catalog & conversation/tool history** | Local SQLite + synced central PostgreSQL replica | Enables teammates to collaborate in shared sessions and read past conversations or tool output when a machine is asleep or offline. |
| **Live Agent turns, Git diffs, terminal I/O, file transfers & desktop video** | Peer-to-peer WebRTC (with TURN relay fallback) | Streams directly between authenticated clients and the machine daemon. Desktop video streams and transferred files are never stored as conversation history. |

## Agents and model providers you connect

When you run Codex CLI, Claude Code, Cursor CLI, Grok CLI, Oh My Pi, DeepSeek Harness, or another ACP agent on an enrolled machine, that agent communicates with its model provider using the account and credentials you configured on that machine. Those providers have their own terms, privacy policies, and data-retention settings. DeskFleet's data promise governs the official DeskFleet service; it does not alter how third-party model providers process requests sent to them.

## Interactive website demos

The interactive workspace examples on this website run entirely in your browser using sample data and local memory state. They do not connect to a backend, launch an agent, run shell commands, or access your computer. Reloading the page resets the examples.

## Optional analytics and marketing attribution

Telemetry and campaign attribution are **opt-in** and controlled at both the server and user levels:

- **Self-hosted by default:** Every self-hosted DeskFleet server defaults to `telemetryEnabled: false` in **Site Administration → General**. While disabled, no analytics or marketing tags run, consent prompts stay hidden, and the backend ignores attribution payloads.
- **Explicit user consent (Google Consent Mode v2):** On sites where telemetry is enabled, analytics and marketing storage (`ad_storage`, `ad_user_data`, `ad_personalization`, `analytics_storage`) start as `denied` until you explicitly opt in via the website consent banner, the desktop Welcome screen, or **Settings → Preferences → Privacy & analytics**.
- **Strict field allowlist:** When you opt in, DeskFleet only records anonymous product lifecycle events, installer/CLI conversion events, and first-touch campaign parameters (`gclid`, `gbraid`, `wbraid`, `utm_*`, and GA client ID) so we can measure download and subscription conversions. Prompts, source code, terminal transcripts, file paths, and workspace names are never included. You can revoke consent at any time in **Settings → Preferences**, which immediately stops client collection and deletes any stored attribution record on the server.
