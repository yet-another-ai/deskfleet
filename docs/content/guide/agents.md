# Agents and collaboration

DeskFleet lets your team run existing CLI coding agents on enrolled machines, collaborate inside the same live sessions, manage Git worktrees and disk usage, step in through terminals, file transfers, and remote desktops, and automate recurring work.

## Configure your preferred agents

DeskFleet connects to **Codex CLI**, **Claude Code**, **Cursor CLI**, **Grok CLI**, **Oh My Pi**, **CodeBuddy Code**, **DeepSeek Harness**, and any other [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) executable. Configure them on each machine that will execute tasks under **Settings → Agents**.

### Installation and status checks

When you add an agent provider, DeskFleet probes the selected machine and reports its state:

- **Ready**: The CLI is installed and authenticated.
- **Not signed in**: The CLI is installed but requires authentication.
- **Not installed**: The CLI was not found on the machine.
- **Installed**: The executable is present, but the CLI does not expose a non-interactive sign-in check (this does not mean you are signed out).

If a built-in CLI is missing, click **Install** to run its official installer on the target machine; for an existing CLI, click **Reinstall** to update or repair it. The dialog streams the installer output and populates the executable path automatically when finished. Open **Advanced** to specify a custom executable path or inject environment variables.

### Authentication and connection testing

- **Log in**: Opens an interactive login terminal on the target machine so you can follow the provider's OAuth link or prompts. For **Oh My Pi**, enter `/login` in its terminal interface, complete authentication, and enter `/quit` to return to setup.
- **Test connection**: Verifies the current executable and credentials without starting a new login flow. If a check fails, click **Details** to inspect the full CLI output.

Each new session selects one configured provider. Available models, reasoning controls, in-flight steering, and session resumption depend on that provider's ACP capabilities.

For **CodeBuddy Code**, choose its built-in template and use **Install** for the
official standalone CLI; Node.js/npm is not required. Use **Log in** or set
`CODEBUDDY_API_KEY` under **Advanced**. Turn on **Use China edition** for China
accounts; leave it off for the international
edition. DeskFleet applies the edition to login and session connections
automatically. Then use **Test connection** to check session creation.
In the login terminal, follow CodeBuddy's startup prompts or enter `/login`,
then `/exit` to return to setup.

## Share a session with your team

Authorized teammates can open and operate the same session concurrently from the desktop app or Web client:

- **Shared backlog & author attribution**: Every message records the teammate who sent it. Prompts submitted while the agent is busy are added to a shared queue and executed in order.
- **Steer now**: When supported by the provider, **Steer now** sends an immediate course correction into the currently running turn instead of waiting for the turn to finish.
- **Shared permissions**: Tool approval requests and agent questions appear for everyone viewing the session. Once any teammate answers a request, the resolution updates across all connected clients.

## Choose where work happens

A **Workspace** binds one or more ordered existing directories on an enrolled machine, with the first directory as the default working directory. When starting a session, choose how files are checked out:

| Mode | Behavior | Best for |
| --- | --- | --- |
| **New worktree** | Creates separate Git worktrees branched from each repository's committed `HEAD`. Uncommitted changes in the main directories are not copied. | Running multiple agent sessions in parallel without file collisions. |
| **Working directory** | Operates directly inside the workspace's existing directories, including uncommitted and untracked files. | Quick edits, non-Git directories, or continuing in-place local work. |

> [!NOTE]
> Worktrees isolate Git working copies on disk; they do not sandbox an agent's OS user permissions or machine access.

## Archive and restore sessions

Leaving a page or closing a desktop window never interrupts a running agent while its machine and daemon remain online. If a machine goes offline, synchronized conversation and tool history remain readable from the central server.

- **Archive**: Stops the session's active processes and removes its generated Git worktrees (including uncommitted changes and untracked files inside those generated worktrees) to reclaim disk space. **Commit any work you want to keep before archiving.** The conversation, queued prompts, and terminal transcripts remain available. Archiving a session that uses **Working directory** never deletes or modifies your source directories.
- **Restore**: Recreates generated worktrees at their last committed `HEAD`s and makes the session active again. Sending a new message starts or resumes the agent provider as supported.

## Step in: Changes, terminals, files, and desktop

Alongside the conversation, DeskFleet gives you direct WebRTC access to the machine's working environment:

- **Changes panel**: Inspect live staged and unstaged file diffs in the session's repositories as the agent edits code.
- **Session & machine terminals**: Open persistent native PTY shells in the session's worktree, workspace, or machine. Terminals support WebGL rendering, buffer search (`Ctrl/Cmd+F`), color themes (DeskFleet, Dracula, One Dark, Nord, Solarized Light), and ANSI/HTML export. Closing a client window does not terminate the underlying shell.
- **File transfers (`Remote control → Files`)**: Use the two-pane file browser to upload, download, and manage files directly between your local computer and any enrolled machine over WebRTC, with confirmation before replacing existing files.
- **Remote desktop (`Remote control → Desktop`)**: Connect to the machine's desktop stream to handle browser sign-ins, visual inspection, or GUI tools, then hand control back to your agent.

## Cross-machine MCP tools and scheduled tasks

### Built-in and custom MCP servers

DeskFleet automatically injects the built-in `@deskfleet/mcp` stdio server into every managed ACP session with a revocable, workspace-scoped credential. Through these MCP tools, an agent can inspect workspace context, list providers, read session history across machines, and manage scheduled tasks—every call is authorized against the delegating user's current team access.

You can also configure additional **stdio**, **HTTP**, or **SSE** MCP servers for a machine under **Settings → MCP Servers**. Their commands, environment variables, and headers are stored locally on that machine outside synchronized history.

### Scheduled tasks

Scheduled tasks automate recurring agent prompts on a specific Machine and Workspace:

- **Triggers**: Run manually, on a fixed minute interval, daily, or on selected weekdays using an explicit IANA time zone and `HH:mm` wall time.
- **Targets**: Start a fresh session (with a chosen provider, model, and worktree/directory mode) or append a prompt to an existing session.
- **Safe execution**: The daemon skips overlapping occurrences if an earlier run from the same task is still active, never auto-approves tool permissions, and retains the 50 most recent run records with status and session links.
