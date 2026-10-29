# Agents and collaboration

## Keep your preferred agent

DeskFleet connects to Codex CLI, Claude Code, Cursor CLI, Grok CLI, DeepSeek Harness, and other ACP-compatible executables. Configure them on the machine that will execute the work in **Settings → Agents**.

When you add an agent, choose its CLI and DeskFleet checks the selected machine for it. The status shows whether the agent is **Ready**, **Not signed in**, or **Not installed**. If a built-in CLI is missing, use **Install** to run its official installer. The dialog shows the installer's output while it runs and fills in the executable when it finishes. Installation availability depends on the target machine's operating system. To use a specific executable or add environment variables, open **Advanced**.

Use **Log in** to authenticate, then follow the authorization link or prompts in the login terminal. **Test connection** checks the current configuration and credentials without starting login. If the test fails, **Details** shows the agent's full output. When a CLI cannot report its sign-in state, the status shows **Installed** instead of **Ready**; this does not mean you are signed out.

A new session chooses one provider. Available model settings, reasoning options, steering, and conversation resumption depend on that provider's capabilities.

## Share a session

Authorized teammates can operate the same session from multiple clients. Each person can read the conversation, add input to the queue, and answer shared permission requests. Messages retain their author; an answered permission is updated for everyone.

When supported by the agent, **Steer now** sends a correction to the current turn. Otherwise, add a request to the backlog for subsequent work.

## Choose where work happens

A workspace contains one or more existing directories on a machine. Its first directory is the default working directory.

- **New worktree** creates separate Git checkouts from committed HEAD. Uncommitted changes are not copied.
- **Working directory** uses the existing directories and their current files, including uncommitted changes.

Worktrees separate working copies; they do not sandbox an agent's access to the computer.

## Inspect and continue

Read tool activity alongside the conversation. Open the Changes panel to inspect file diffs and the session terminal to work in the same directories.

Leaving a page or closing a desktop window does not stop the agent while its machine and daemon remain running. Quitting the desktop app stops the daemon it hosts. Synchronized conversation history remains readable when a machine is offline.

Archiving stops the session's active processes and retains the conversation, worktree files, queued input, and terminal transcripts. Restoring makes the session available again; a later message starts or resumes its provider as supported.
