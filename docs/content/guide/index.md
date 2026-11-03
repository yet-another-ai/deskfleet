# Welcome to DeskFleet

DeskFleet brings the coding agents running across your team's workstations and headless servers into one shared place to work. Keep using the agents you already know on the computers where your repositories and tools live, collaborate in the same session with teammates, and step into the working environment whenever human hands are needed.

## How DeskFleet is organized

DeskFleet structures work around a simple, explicit hierarchy:

| Concept | What it represents |
| --- | --- |
| **Team** | The shared boundary for members, enrolled machines, permissions, and synchronized history. |
| **Machine** | A workstation running the DeskFleet desktop app (which hosts a local daemon in its main process) or a headless server running the standalone `deskfleet-daemon` binary. One physical machine can register with multiple teams, keeping separate catalogs, credentials, and sessions for each team. |
| **Workspace** | One or more ordered local directories on an enrolled machine. The first directory is the default working directory. |
| **Session & Worktree** | A live conversation with an ACP agent inside a Workspace. Each session either generates its own isolated **Git worktree** from committed `HEAD` or works directly in the Workspace's existing directories. |

## Core capabilities

### Bring your own agents (ACP)

Connect installed and authenticated [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agents on each machine—including **Codex CLI**, **Claude Code**, **Cursor CLI**, **Grok CLI**, **Oh My Pi**, **DeepSeek Harness**, or custom ACP executables. Your agent runs directly on the selected machine using its local compilers, containers, files, and credentials.

### Work together in real time

Authorized team members can open the same agent session from the desktop app or Web client. Read the live conversation, queue follow-up requests in a shared backlog with author attribution, steer an active turn in flight, and answer shared tool permission prompts once for everyone.

### Step into the machine over WebRTC

When a task needs manual inspection, browser sign-in, or interactive debugging, DeskFleet connects you directly to the machine over authenticated WebRTC (with automatic TURN relay fallback):

- **Changes panel**: Review live staged and unstaged Git diffs alongside the conversation.
- **Native PTY terminals**: Open persistent shells scoped to a machine, workspace, or session worktree.
- **File transfers**: Browse and transfer files between your computer and any enrolled machine in a two-pane view.
- **Remote desktop**: Stream and control the machine's desktop directly from DeskFleet.

### Coordinate and automate

Every managed session receives a built-in `@deskfleet/mcp` server so agents can inspect workspace context, session history, and schedules across enrolled machines. You can also configure recurring **Scheduled tasks** that run automatically while the daemon is active.

## Explore the workspace

The [interactive homepage demos](/#explore) run the real DeskFleet interface in your browser with sample data—let you switch machines and agents, inspect a code change, try a remote desktop connection, and participate in a shared team session without installing or signing in.

## Start here

- [**Run DeskFleet**](./getting-started) — Install the desktop app, enroll a workstation or headless server, create a workspace, or run the local development stack.
- [**Agents & collaboration**](./agents) — Configure ACP providers, share sessions, manage Git worktrees and archives, use terminals and file transfers, and schedule tasks.
- [**Privacy & data promise**](/privacy) — Understand what stays on your machines, what is synchronized for offline reading, and our zero-training guarantee.

The complete client, daemon, and server are [open source under Apache-2.0](https://github.com/yet-another-ai/deskfleet).
