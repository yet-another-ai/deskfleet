# Scheduled tasks and Agent MCP tools

Scheduled tasks belong to one enrolled Machine and one Workspace. The daemon
owns their timer, configuration, and recent execution records in
`<machine directory>/scheduled-tasks.json`. Electron and Web manage them through
the authenticated machine RPC API. Closing a window or disconnecting a viewer
does not stop the timer; quitting the hosting Electron application or stopping
the headless daemon does.

The daemon also publishes a public, read-only task snapshot to central PostgreSQL
on connection and after committed task changes. This snapshot supports Team-wide
search over task titles and prompts and lets clients inspect the last synchronized
task details while a Machine is offline. Editing and execution still require the
owning daemon. The snapshot excludes saved actor delegation and internal dispatch
operation IDs. Each publication replaces that Machine's task inventory, so deleted
tasks disappear after synchronization. Retries read the latest committed snapshot;
chat streaming does not repeatedly publish unchanged schedules.

## Targets and timing

A task contains a title, prompt, enabled state, Workspace, execution target, and
trigger. A new-Session target captures the provider ID, model/reasoning/mode
selection, and directory or generated-worktree context. An existing-Session
target retains that Session's provider and execution context. Workspace is
required, and cannot change after task creation. Removing a Workspace requires
removing its scheduled tasks first. Deleting a task retains its existing
Sessions, Worktrees, and history.

Triggers are manual, a minute interval, daily, or selected weekdays. Daily and
weekly triggers store an explicit IANA time zone and `HH:mm` wall time, so a
different viewer's clock does not move the schedule. A browser time control
that reports seconds is stored at minute precision. A nonexistent daylight
saving time is skipped; a repeated wall time uses its first occurrence only.
The UI shows the next occurrence and its time zone. Intervals advance from the
current dispatch time and do not replay a backlog of missed occurrences.

On startup, expired deadlines advance to the next future occurrence. There is
no catch-up burst after a machine has been off. A timer that wakes late while
the daemon is running claims one due occurrence and advances to the next one.
Pause disables automatic triggers; Run now can still execute a paused or
manual task. Changes affect future claims, not work already accepted.

## Execution and recovery

The scheduler persists a claim and operation IDs before creating a Session or
submitting its prompt. It uses the same Session creation, captured directories,
configuration, input backlog, command audit, provider supervision, and approval
flow as an interactive user. It never answers a permission or user question.
An existing Session receives an ordinary backlog input. If an earlier input
from the same task remains active or uncertain, another occurrence is recorded
as skipped rather than creating overlapping scheduled work.
Once a Session finishes archiving, its retained inputs no longer block later
occurrences. Restoring it makes any still-pending input count toward overlap
again. A Session still closing during archive continues to block dispatch.

Recent runs record claim/running/completed/failed/interrupted/skipped state,
timestamps, associated Session and input IDs, and errors. Completion follows
the journal's actual input/turn outcome, not just a successful RPC response.
The most recent 50 runs are retained. A run that is still blocking, or an
archived run whose pending input would block again after restore, is kept when
that cap would otherwise drop it. Provider removal, an archived target, failed
provisioning, and authorization failures appear in run history.

Restart recovery inspects durable command receipts and the recovered Agent
journal. It never automatically repeats an uncertain prompt submission.
Pending or uncertain inputs remain subject to the existing Session recovery
workflow. A failed authorization or dispatch advances the automatic schedule;
there is no hidden retry loop.

## Authorization

Create/update stores the verified initiating user's identity, not a login
credential. Saving changes adopts the saving user's delegation. Run now uses
the requesting user; automatic execution uses the saved user. Before every
dispatch the machine authenticates to `/api/daemon/authorize-delegation`, which
checks that the user is still a member of that machine's Team. The machine
credential fixes the target; request arguments cannot choose another machine.
An expired login does not erase saved schedule intent, but membership removal
or machine revocation prevents new dispatch. Backend unavailability fails the
occurrence without granting offline authorization.

## Independent MCP server

`@deskfleet/mcp` implements the standard MCP stdio server independently of an
ACP provider. It accepts a tool dispatch callback when embedded as a library.
The standalone entry uses `DESKFLEET_MCP_ENDPOINT` and `DESKFLEET_MCP_TOKEN` to
reach the daemon's private loopback bridge. These values are issued for one
running Agent Session; neither is the local discovery token or a central login
credential.

The daemon injects its built-in `deskfleet` server through ACP `mcpServers` on
each managed Session creation or resume. Its executable entry is bundled into
both the headless SEA and Electron runtime as `--deskfleet-mcp`; no separately
installed Node runtime is required for packaged applications. ACP requires
stdio MCP support. Configuration probes do not receive execution authority.

Each built-in grant binds the initiating user, machine, Workspace, and Session.
Calls recheck current Team membership and the issuing Session's active state.
Provider shutdown, failed startup, archive, and daemon shutdown retire the
grant. Tools expose the scoped catalog, public provider identities, Session
state/history, and schedule list/create/update/delete/run operations. Generated
arguments cannot replace the actor, select a different Workspace, or retrieve
provider launch secrets. The separate remote tools below extend discovery to
other machines without expanding the local Workspace delegation.

## Cross-machine Agent access

Desktop **Preferences → This computer** has two independent switches, both off
by default: allow Agents on other machines to read this computer, and allow
them to operate it. Consent is stored in `<host directory>/remote-agent-settings.json`
as `{"allowRead": false, "allowOperate": false}`. A headless operator can set the
same file. The preference applies across this host's registrations; every call
still stays inside the source registration's Team and backend. A caller cannot
choose another Team. Reading conversations and operating MCP tools are separate
permissions; enabling operations does not grant conversation access.

The issuing daemon checks the active Session and its user's current membership,
then calls `/api/daemon/mcp` with its own machine credential. The backend repeats
membership checks for source and target, resolves the target's Team registration,
and forwards a dedicated management RPC with the verified source Machine and
Session. The target validates this context and reads the current host preference.
These internal RPCs are absent from the public management method allowlist.
Machine discovery asks online targets for live consent and omits offline or
denying machines. No synchronized history is returned without a live target
permission check. Calls cannot replace the originating user or pass an arbitrary
management method, executable, endpoint, or credential.

| Tool | Target permission | Result |
| --- | --- | --- |
| `deskfleet_remote_machines` | Read or operate | Other online machines in the same Team and their current permissions |
| `deskfleet_remote_machine` | Read | Catalog, Workspaces, directories, and public provider identities |
| `deskfleet_remote_sessions` | Read | Sessions, optionally filtered by Workspace |
| `deskfleet_remote_session` | Read | Session state and conversation snapshot |
| `deskfleet_remote_session_history` | Read | Recorded event pages, using `afterSeq` and a limit of 1–200 |
| `deskfleet_remote_mcp_servers` | Read or operate | Enabled configured server IDs, names, and transports |
| `deskfleet_remote_mcp_tools` | Read or operate | MCP tool schemas, with cursor pagination |
| `deskfleet_remote_mcp_call` | Operate | The original MCP tool result, including content, structured content, and errors |

Tool discovery and execution create a request-owned MCP connection on the target
using its saved stdio, Streamable HTTP, or SSE settings. Stdio starts in the host
directory. Launch environment and HTTP headers stay on that target. Every tool
call requires operate permission, regardless of the server's `readOnlyHint`.
Consent and server configuration are rechecked after initialization; closing the
daemon cancels pending remote MCP requests. Connections close when requests finish.
An in-progress tool can already have side effects when a deadline expires or
permission changes; no automatic retry is performed.

Remote tools cannot invoke the built-in DeskFleet server, its schedule mutations,
Agent prompts, steering, or approvals. Direct cross-machine Agent messaging is
reserved for later work. Configured third-party MCP tools execute with the
target OS user's existing authority when operate permission is enabled.

Requests and results pass through the existing backend management transport and
its transient cross-instance inbox, within that transport's size and time limits.
The central backend therefore remains inside their trust boundary. The request
retains the initiating user, source Machine and Session; the source Agent's MCP
tool activity uses its existing conversation recording. Connection configuration
and saved secrets are never included in server discovery responses.

## Additional MCP servers

Settings has a separate machine-level **MCP Servers** section that lists only
user-configured servers. The built-in `deskfleet` server is not displayed there;
it remains automatically injected and cannot be replaced by a user-defined
server. Configured servers have their own enabled state and transport
configuration; they apply the next time a Session starts or resumes.
Stdio entries configure command, arguments and environment. HTTP/SSE entries
configure URL and headers and require the selected ACP agent to advertise the
corresponding transport capability. An unsupported enabled transport produces
an explicit startup error rather than disappearing silently.

Additional server launch settings and secrets stay in the owning machine's
private configuration, outside synchronized catalogs and conversation history.
These settings are machine management operations for authenticated Team members;
the built-in Agent tools cannot edit MCP server credentials.

## Validation

Scheduler tests exercise calendar/time-zone boundaries, persistence, missed
deadlines, concurrent claims, overlapping inputs, journal completion, and crash
recovery. MCP tests use a real stdio MCP client and cover scoped authority and
lease retirement. Remote MCP tests also exercise HTTP/SSE credentials, cursor
pagination, permission changes, and tool-error forwarding. UI tests cover
schedule editing and machine settings. Central delegation and cross-machine
Team-isolation HTTP tests require a real PostgreSQL `TEST_DATABASE_URL`.

ACP references: [MCP integration](https://agentclientprotocol.com/protocol/session-setup)
and [capability negotiation](https://agentclientprotocol.com/protocol/initialization).
