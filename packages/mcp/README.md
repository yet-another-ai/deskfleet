# DeskFleet MCP

`@deskfleet/mcp` exposes Workspace context, Session inspection, and scheduled-task
management through standard MCP stdio. It does not depend on a particular ACP
Agent implementation. The owning daemon executes operations and checks the
delegating user's current team access on every call.

DeskFleet injects this server in `mcpServers` when starting or resuming an ACP
Session. Each running Session receives its own revocable credential, restricted
to its Workspace. Closing the provider process, archiving the Session, or
stopping the daemon revokes it. Configuration probes do not receive tools.

The built-in `deskfleet` server is always included and cannot be disabled or
replaced. Machine settings can add other stdio, HTTP, or SSE servers. Their
commands, environment, URLs, and headers are stored in the machine's
`mcp-servers.json`, outside synchronized history. Use an absolute executable path
for stdio commands. Changes apply when an Agent Session next starts or resumes;
existing connections retain their current configuration. An enabled HTTP or SSE
server requires the Agent to advertise the corresponding ACP capability. An
unsupported transport produces an explicit Session startup error.

The reusable `createMcpServer(invoke)` entry point accepts an operation callback.
The standalone executable uses `DESKFLEET_MCP_ENDPOINT` and `DESKFLEET_MCP_TOKEN`
from the host's environment. These values must come from a live daemon Session
grant; the local discovery token is not a resource credential. Never copy a
grant into a prompt, repository file, or persistent provider configuration.

For source development with the locked Node runtime:

```sh
mise exec -- node packages/mcp/src/main.ts
```

Packaged desktop and standalone daemon distributions route `--deskfleet-mcp`
through their existing executable, so Agent subprocesses do not require another
Node installation. All stdout is MCP protocol traffic; errors go to stderr.
