# Agent Session persistence and ACP transport

The daemon owns persistent Agent Sessions, their provider processes, and their
conversation journal. Electron uses the same ACP DataChannel facade intended for
remote clients. This document owns the collaboration, persistence, and transport
contract; [architecture](architecture.md) owns the resource hierarchy.

## Ownership and collaboration

All authorized clients can operate on a Session simultaneously, without a control
lease. The daemon orders state
changes, input delivery, and permission decisions. Client connections, provider
processes, and durable Sessions have separate lifetimes: closing every viewer
leaves the Agent running and its approvals pending.

```mermaid
flowchart LR
    A[Client A] <-->|ACP over DataChannel| D[Daemon Session service]
    B[Client B] <-->|ACP over DataChannel| D
    D <-->|One ACP connection per running Session| P[Agent / ACP adapter]
    D --> S[SQLite catalog and Session journal]
    S -.->|Future history synchronization| C[Central server]
```

A managed Session belongs to one Workspace and records an immutable `context`.
A `worktree` Session owns generated checkouts; a `directory` Session uses the
Workspace's own directories in place. Its captured ordered directories are the
execution context; the first supplies `cwd`. Later Workspace edits do not
retarget existing Sessions. Session creation also retains a failed provisioning
record when Git setup fails or a directory is missing. Stopping a provider
preserves the Session and its files. The current deletion path removes a worktree
Session's disposable checkouts before deleting the catalog resource; a directory
Session's files are never removed. The new-session composer offers both contexts
and remembers the last choice on that device.

## Archive and restore in the backend release

Archive is the normal user action for ending active use of a Session. It is
reversible and preserves the Session identity, execution context, Worktree files
(including uncommitted changes and untracked files), queued inputs, configuration,
conversation/tool history, terminal records, and full audit. Permanent Session
deletion is not exposed by first-release user interfaces or user-facing APIs;
the destructive operations documented below describe existing implementation.

Archive requires the owning machine online. The daemon blocks new execution and
backlog dispatch, closes the provider and its pending permission callbacks without
granting them, and stops Session-owned terminals while retaining their final
output and metadata. It records the resulting execution/permission transitions
without deleting their history. Archive completes only after the associated
live resources have closed. There is no queued offline archive in this release.

Restore returns the same Session to active use without starting the provider,
dispatching queued inputs, or creating terminals. The next explicit message can
resume the provider using its existing capabilities. A later terminal start
creates a new PTY while preserving the ended terminal's record and transcript.
Reading an archived Session cannot trigger implicit resume or terminal creation.
Archive state must be durable and synchronized, distinct from provider process
state. Archived Sessions retain their Workspace ownership and Worktree records.

Archive cannot reuse Session destruction or terminal hangup, both of which delete
data today. See [terminal archive behavior](terminals.md#ownership-and-lifecycle)
and the [backend scope](backend.md#session-archive-and-restore).

## Provider configuration

Each daemon owns its machine's provider settings in
`agent-providers.json` in the active machine directory (initially
`<daemon directory>/machine/`). Settings → Agents lists those providers
and supports adding, editing, and removing them through authenticated backend
management RPC to the target daemon.
The initial configuration contains a Codex provider. Removing all providers
leaves the machine unconfigured until one is added; startup does not recreate
deleted entries.

A provider has a stable ID, a template, a display name, an optional icon, an
optional binary path, and environment overrides. Icons are bundled catalog slugs;
omitting one uses the template's default icon. Icon selection affects display
only and does not change execution. The Codex template runs the installed Codex CLI
through the bundled ACP bridge; its default binary is `codex`. The Claude Code
template runs the installed Claude Code CLI through the bundled
[Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp);
its default binary is `claude`. The Cursor template runs the installed
[Cursor CLI](https://cursor.com/docs/cli/acp) directly as `agent acp`; its default
binary is `agent`. Sign in with `agent login`, or set `CURSOR_API_KEY` or
`CURSOR_AUTH_TOKEN`, before starting a session. When a session can ask the user
a question, `cursor/ask_question` is answered through that form.
`cursor/create_plan` and Cursor's notification methods are not implemented;
unrecognized requests receive JSON-RPC method not found. The Grok template runs
the installed [Grok CLI](https://docs.x.ai/build/cli/headless-scripting) directly
as `grok agent stdio`; its default binary is `grok`. After initialization it
calls `authenticate` with `xai.api_key` when `XAI_API_KEY` is set and that method
is advertised, and otherwise with `cached_token` from `grok login`. Interactive
methods are not passed to `authenticate`. Deskfleet does not add
`--always-approve`, so tool approval stays on the existing permission UI.
`x.ai/ask_user_question` and `_x.ai/ask_user_question` use the same question form.
The Pi Coding Agent template runs the installed `pi` CLI through the bundled
[`pi-acp`](https://github.com/svkozak/pi-acp) adapter, which starts Pi in RPC mode.
It supports model and thinking-level selection and loading saved sessions.
Pi executes its tools locally; the adapter does not delegate filesystem or
terminal operations, forward client-provided MCP servers, or expose additional
Workspace directories. Pi extension select/confirm requests use the permission
UI; extension free-text input requests are unsupported.
The DeepSeek Harness template runs the installed
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI (`dsh`)
directly as `dsh --profile acp`; its default binary is `dsh`. Set
`DEEPSEEK_API_KEY` in the provider environment (optional `DEEPSEEK_BASE_URL`)
before starting a session. The ACP automation profile does not advertise
interactive authenticate methods. Settings installs the CLI with
`npm install -g @deepseek-ai/dsh`.
The ACP template
runs an ACP-compatible executable directly over stdio, with `acp-agent` as its
default binary. Blank paths use the template default. Overrides are added to the
daemon's inherited environment at process startup.

Adding a provider first chooses its template; editing opens the form directly.
The form probes the selected machine as soon as it opens or the template
changes, and again after executable or environment edits. Discovery
checks the configured path or the machine's PATH and official user installation
locations, confirms the built-in CLI's identity, and reports its resolved path.
The resolved absolute path is used when saving the provider. Credential status
is read separately where the CLI supports it; an unavailable status remains
unknown. Executable discovery never starts an ACP session or login flow.
The dialog reduces the result to one status: ready, installed with unknown
credentials, not signed in, not installed, unusable, or a failed check. The
resolved path is the default shown for the executable field, which sits with
environment overrides in a collapsed Advanced section unless the provider
already overrides either.

Missing built-in CLIs offer **Install**, using the vendor's official installer
on supported platforms. **Log in** is a separate action once the CLI is found.
Both actions run in dedicated machine-owned terminals, with output, interactive
input, and explicit cancellation in the dialog. Output closes after a successful
exit once the refreshed status appears, and remains after a failure. The daemon selects the command
and passes environment overrides directly to the process. Installation does not
imply authentication: completion triggers a new probe, and successful installation
fills the executable's absolute path. Custom ACP providers have discovery but no
built-in installation or login action. Setup uses authenticated machine management
RPC; terminal interaction uses the existing WebRTC terminal channel.
Pi installation uses the official `pi.dev` installer. Its **Log in** action opens
Pi; enter `/login`, complete provider setup, then `/quit`. Discovery leaves Pi's
credential status unknown because its credential check requires a specific model
or model provider. **Test Connection** checks whether a session can be opened.

The provider dialog's **Test Connection** button sends the unsaved settings to the daemon, which starts the agent,
initializes ACP, and opens one session in an empty temporary directory without
sending a prompt, then closes it. The test runs beside other management requests,
gives up after 30 seconds, and reports the agent's own failure details: the
first line is shown inline and the full output on request. It only
uses existing credentials. Codex's bridge default-login setting is disabled for
tests, and Cursor tests skip `cursor_login`, which can otherwise open browser
authentication. Missing authentication asks the user to use **Log in** instead.
Template selection is
immutable after creation because it determines the launch and configuration
contract; the name, icon, path, and environment remain editable.

The desktop bundles monochrome marks from
[`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) for its
searchable icon chooser. Icons follow the interface color and work offline.
The selected mark appears in provider settings, the composer, and Session links.

New Sessions select one configured provider and persist its ID in `provider`.
The daemon checks that ID before allocating a Session. Each process launch,
including resume after a stop or daemon restart, resolves the saved ID to the
latest configuration. Editing or removing a provider leaves its running
processes and existing Session history intact. A removed provider cannot start
new processes, so resuming one of its stopped Sessions records an explicit
startup error. Provider environment values stay in machine settings and are
never copied into Session creation commands or the conversation journal.

## Identity and audit

Database resource IDs remain signed 64-bit integers, encoded as decimal strings
on the wire. A persistent catalog origin UUID qualifies remote references as
`{ originId, id }`. A new database gets a new origin. Session IDs, opaque provider
conversation IDs, and connection-local JSON-RPC request IDs are distinct.

Every mutation has a client-generated UUID `operationId` and a daemon-assigned
command ID. Its actor comes from the authenticated connection, never request
parameters or `_meta`. The actor contains `kind`, optional `userId`, an optional
qualified `sourceMachine`, and optional `deviceId`. Input authors and the people selecting
those inputs for steering are recorded separately. Default backlog dispatch is
a system action. The target machine is the daemon's catalog identity.

Central signaling binds peers to verified users and login/device identities.
Resource creation requires OIDC login and Team enrollment. A Web client can
have no enrolled source Machine; `sourceMachine` is then absent. The target
machine is never assigned as the browser's identity. Local discovery credentials
permit host setup; `local_token` actors remain only in explicit in-process test
fixtures and internal development helpers.
The [WebRTC authorization context](webrtc-security.md) binds that actor to the
authenticated SDP exchange, target Machine, allowed actions, and a maximum
24-hour peer lifetime. The daemon supplies the actor from this context and
enforces revocation/expiry; neither ACP parameters nor a channel label grants
authority. Peer closure detaches viewers without stopping the provider or
resolving pending approvals.

Canonical operation IDs are unique within the catalog. Repeating the same actor,
method, target, and parameters returns the saved receipt/result. Reusing an ID
with different parameters or identity appends a rejected noncanonical command
linked to the original. It never replaces the original audit. JSON-RPC IDs can
coincide between clients without referring to the same operation.

Commands retain actor, target, parameters, received/completed timestamps, status,
result, and error. Deleting a Session clears live foreign keys while retaining
immutable target IDs and audit JSON, including the delete receipt. A retry of an
interrupted delete resumes cleanup, or completes its receipt if the target was
already removed. Failed operations require a new operation ID to attempt again.

## Persistence model

The local SQLite catalog is the authoritative Agent database. PostgreSQL stores
queryable replicas of its snapshots, events, and command audit. `deskfleet-store` owns
SeaORM transactions, `deskfleet-model` owns typed records, and `deskfleet-node`
exposes thin JSON bindings. The daemon owns scheduling, Git orchestration, and
ACP callbacks. Records preserve ACP payloads as JSON; indexed columns enforce
ownership, lookup, and active-resource constraints.

| Table | Key | Responsibility |
| --- | --- | --- |
| `catalog_identity` | Singleton | Persistent catalog origin UUID |
| `agent_id_allocator` | Singleton | Durable IDs for commands, inputs, turns, and permissions |
| `workspace_sessions` | Existing `id` | Canonical Workspace ownership |
| `agent_sessions` | `session_id` | Provider identity, title, lifecycle, archive state, capabilities, journal watermark, timestamps/error |
| `agent_runs` | `(session_id, generation)` | Provider process state and start/end timestamps/error |
| `agent_commands` | `id`; canonical `operation_id` | Immutable request audit and mutable receipt/outcome |
| `agent_inputs` | `id` | Content/author, submission command, acceptance sequence, requested and actual delivery, dispatch command/actor |
| `agent_turns` | `id` | Initial input/dispatch command, run generation, execution state, stop reason |
| `agent_permissions` | `id` | Original ACP request/options, run/turn, winning decision command/actor |
| `agent_events` | `(session_id, seq)` | Ordered domain transitions and original ACP notifications |

Session lifecycle is `provisioning`, `ready`, `provision_failed`, or `deleting`.
Independent `archiveState` is `active`, `archiving`, or `archived`. Archive first
persists `archiving` to close admission, then stops provider processes and owned
terminals, and only then commits `archived`. A failed close retains `archiving`
and can be retried with a new operation ID after restart. Restore permits only
`archived` to `active`; it does not start processes or dispatch backlog.
Runs are `starting`, `running`, `stopping`, `stopped`, `interrupted`, or `failed`.
Each new provider process gets a new generation, including when resuming a saved
conversation. Busy/idle/awaiting-approval are derived from turns and permissions.
Process handles and connected viewers stay in memory.

Inputs are `pending`, `dispatching`, `delivered`, `failed`, `withdrawn`, or
`uncertain`. Requested delivery (`backlog` or `steer`) and requested target turn
remain distinct from actual delivery (`turn_start` or `steer`) and actual turn.
One turn starts with one input and may receive several steering inputs. A
candidate does not allocate a turn until dispatch. An explicitly retried failed
input can acquire another turn; its earlier attempts remain in commands/events.

Turns are `starting`, `running`, `cancelling`, `completed`, `cancelled`,
`interrupted`, or `failed`. Permissions are `pending`, `resolved`, or `cancelled`.
Selecting a reject option is a resolved decision; cancellation means the request
is no longer live.

### Transaction boundaries

- Native constraints allow only one live run and one live turn per Session.
  Inputs, turns, permissions, and event references must belong to that Session.
- State changes and their events commit together with a compare-and-set journal
  watermark. Event sequences increase within the transaction. Publish only
  committed events; use one Session queue for domain commits and ACP callbacks.
- Atomically claim an input before any provider call. A withdraw, backlog dispatch,
  and steer cannot each consume the same candidate. Delivery callbacks must match
  the recorded dispatch command before changing the input.
- Permission resolution checks the pending state inside the same transaction as
  the decision audit and event. Invoke the upstream callback only after commit.
- Never hold a database transaction while waiting for Git, a provider, a prompt
  response, or a human decision.

Creation atomically allocates the catalog Session, provisioning metadata, and
command binding before filesystem work. Interrupted create retries return a full
Session snapshot rather than allocating another Session. Deletion marks the
Session `deleting`, stops admission, closes the provider and pending permissions,
removes any owned checkouts, and removes Session records. Incomplete cleanup retains
the deleting resource for an explicit retry. Source checkouts are untouched.

The composer accepts text. Provider content, plans, tool patches, and unknown
metadata remain in the journal. Attachments are not yet implemented. Credentials
stay on the executing machine and are not stored in audit records.

## Backlog, steering, and cancellation

Ordinary messages enter a shared backlog ordered by acceptance sequence. An idle,
running Session takes its oldest pending input. During work, the composer offers
**Add to backlog** and **Steer now**. Each pending candidate can be steered or
withdrawn by any authorized client. A confirmed failed candidate offers an
explicit retry. Failed and uncertain inputs never auto-retry.

Submission returns a durable receipt with `operationId`, command ID, input ID,
and Session ID. This receipt is distinct from the provider's `session/prompt`
response, which arrives only when the turn finishes. The facade does not expose
`session/prompt` to the composer; it uses the input extensions to preserve queue
and steering semantics.

A selected candidate keeps its original content and author. Steering records the
selecting actor and observed turn, claims the input, and reserves dispatch while
the provider answers. Competing delivery attempts fail and leave the unconsumed
input available for explicit retry.

### Codex steering boundary

The pinned `@agentclientprotocol/codex-acp` 2.2.2 package has a repository patch
for strict steering. It advertises both `_meta.steering.supported` and
`_meta.steering.supportsPromptRequired`. The request is `_session/steering` with
`_meta.steering.idleBehavior: "promptRequired"`; deskfleet also includes its
delivery command ID under `_meta.deskfleet`.

The adapter returns `injected` if it accepted the input into the active turn.
If the turn ended before injection, it returns `promptRequired` without starting
an internal prompt. The daemon then waits for the old prompt's completion and
starts a normal, tracked `session/prompt` with the steering input. This preserves
stream attribution and the final prompt outcome, including inline commands and
adapter follow-up work. Backlog dispatch stays reserved across that boundary.
An already-replaced observed turn is a stale target and is not steered.

The upstream fallback's `startedNewTurn` acknowledgement hides the final prompt
response, so it is not used. Generic failures or lost steering responses do not
prove non-delivery: mark them `uncertain`. Advertise steering only when the
strict capability is negotiated. The patch and active/idle/turn-ending cases are
covered by provider tests against the installed adapter implementation.

The timeline shows normal prompts as **In progress** until completion and steering
inputs as **Sending** until acknowledged. Unknown outcomes stay visible for
inspection and are not automatically retried.

Cancellation names a specific `turnId`. An active target becomes `cancelling`;
provider completion supplies its final state. A completed target is an audited
no-op. Recheck the active turn after asynchronous work so a late cancellation
cannot cancel the next turn or its approvals. Withdrawal affects only the named
input. Stopping a provider retains pending backlog until the next request.

A new or retried message to a stopped, interrupted, or failed agent resumes it;
archived Sessions require explicit restoration before this path.
Successful startup then drains the backlog in acceptance order. The UI shows no
stopped or resume state. A provider that cannot resume its saved conversation
rejects the message instead of queueing it, and the UI explains that a new
Session is needed. A startup failure is recorded on the run and Session, keeps
the message queued, and is retried by the next request.

## Shared permissions

Persist each request with a stable permission ID before showing it. All attached
clients see the same options. The first valid decision wins; later decisions
return that outcome and retain their own command audit. Only the winning commit
invokes the live provider callback.

Each viewer also receives standard `session/request_permission` with a
connection-local RPC ID and the durable permission ID in `_meta.deskfleet`.
The UI records a button click through `_deskfleet/permission/respond`; a mirrored
resolution merely closes its outstanding fan-out with `cancelled`, so spectators
are not recorded as making a decision. Standard selected responses are also
supported and yield `_deskfleet/permission/receipt` notifications.

The service broadcasts resolution and the deciding actor. `$/cancel_request`
closes obsolete fan-outs. Disconnects and RPC errors leave the shared request
pending until an approver responds, the turn ends, or the provider cancels it.

## User questions

Managed providers receive the ACP `elicitation.form` capability and send
`elicitation/create` requests for structured user input. Codex maps its
`request_user_input` tool to this interface. The daemon accepts session-scoped
forms; it does not advertise URL elicitation. Direct CLI invocations without an
input callback do not advertise form support and do not register vendor question
methods.

Cursor's `cursor/ask_question` and Grok's `x.ai/ask_user_question` and
`_x.ai/ask_user_question` are translated into that form when the callback is
installed. Cursor's documented request has no session id, so the question is
scoped to the session this connection most recently opened or prompted. An
answered form becomes Cursor's nested `{ outcome: { outcome: "answered", answers } }`
result, using option ids, or Grok's `{ outcome: "accepted", answers }` map of
question text to selected labels. Decline is Cursor `skipped` and Grok
`cancelled`; cancel is `cancelled` for both. Grok's plan-mode outcomes
`chat_about_this` and `skip_interview` are not separate actions. A request that
cannot be shown is cancelled rather than left unanswered.

Each request is persisted with a durable elicitation ID, its provider run and
turn, and its original form schema before clients see it. Snapshots and
`elicitation` journal events carry the shared state. The desktop renders questions
inline, including choices and their descriptions, free text, optional additional
answers, and the primitive fields supported by ACP forms. Secret fields use
masked inputs and are redacted from persisted answers and command audit.

Clients submit through `_deskfleet/elicitation/respond` with an operation ID and
an ACP response (`accept` with content, `decline`, or `cancel`). The daemon
validates accepted answers against the requested schema. The first valid
decision wins and invokes the provider callback only after commit; later
responses return the recorded outcome. Reconnecting or navigating away leaves
the question pending. A provider cancellation or timeout, turn completion, or
provider loss closes unanswered forms; daemon restart cancels requests whose
provider callbacks no longer exist.

## ACP over DataChannel

Each client initializes an independent JSON-RPC connection over one reliable,
ordered `deskfleet-acp` DataChannel, multiplexing its Session subscriptions.
The daemon terminates that connection and owns the separate ACP SDK connection
to each provider. RPC IDs are never forwarded between viewers and providers.
`PROTOCOL_VERSION` remains `1` while contracts are provisional.

The wire format is UTF-8 NDJSON in binary chunks, at most 16 KiB per chunk (or the
browser's negotiated SCTP limit when lower). Chunks are not JSON boundaries.
Readers reconstruct split JSON and Unicode; writers finish a message before
starting another. A reconstructed message has a 32 MiB limit, advertised at
initialization. Viewer queues and outstanding requests are bounded. Native
backpressure is retried within a bounded send deadline; a stalled viewer detaches
without blocking the provider or other clients. Reconnection reads SQLite again.

The receive loop dispatches requests concurrently instead of waiting for one
request to finish before accepting approvals and cancellation. Authentication is
bound at signaling; the DataChannel label itself is not authorization. Local
Electron IPC supplies discovery and SDP/ICE signaling only, not a separate
conversation API. Remote authenticated signaling can reuse this facade.

| Operation | Contract |
| --- | --- |
| `initialize` | Negotiate protocol, facade capabilities, byte limit, and catalog identity |
| `_deskfleet/session/list` | Read persisted Session summaries |
| `_deskfleet/agent/configuration` | Discover provider model, reasoning, and mode choices for a draft in a Workspace's default directory |
| `_deskfleet/session/create` | Idempotently create a worktree or directory Session with a configured provider ID, apply optional model/reasoning/mode selections, and start it; return snapshot |
| `_deskfleet/session/configuration` | Read the Session's confirmed provider configuration |
| `_deskfleet/session/configure` | Audit and apply model/reasoning/mode changes to a Session without changing its provider |
| `_deskfleet/session/subscribe` | Attach and return snapshot with `session.lastEventSeq` watermark |
| `_deskfleet/session/history` | Page events after a sequence; up to 200 events per request |
| `_deskfleet/git/status` | Inspect the Session's captured checkouts, branch/HEAD, and staged/unstaged/untracked files |
| `_deskfleet/git/diff` | Read one changed file's patch by Session, repository, relative path, and change kind |
| `_deskfleet/input/submit` | Persist text with operation ID and backlog/steer intent |
| `_deskfleet/input/steer` | Claim a candidate and steer toward the observed turn |
| `_deskfleet/input/retry` | Make a confirmed failed input pending again |
| `_deskfleet/input/withdraw` | Withdraw a pending or confirmed failed input |
| `_deskfleet/turn/cancel` | Cancel only the named execution turn |
| `_deskfleet/permission/respond` | Audit an offered permission decision |
| `_deskfleet/elicitation/respond` | Validate and audit an answer or dismissal of a shared user question |
| `_deskfleet/session/event` | Deliver committed domain and original ACP events |
| `_deskfleet/command/get` | Read the receipt/outcome after response loss |
| `_deskfleet/session/resume`, `/stop` | Explicit provider lifecycle operations; input submission also resumes |
| `_deskfleet/session/archive`, `/restore` | Backend management operations; preserve data and require an online daemon |

ACP notifications, including provider Session IDs, are carried in journal
events and projected once by the renderer. Mode metadata is normalized as
described below. The facade advertises only supported
methods. Managed creation takes a Workspace whose directories determine `cwd`.

Git reads require a ready Session and resolve its owned Worktree through the
catalog, including captured paths for directory Sessions. They do not accept
caller-supplied working directories, start a provider, require an operation ID,
or append journal events. Repository IDs select only checkouts resolved from
that Session's paths. Diffs distinguish index changes from working-tree changes
and include untracked file previews. Binary files and truncated patches are
reported explicitly. Checkout errors do not hide healthy checkout results.

### Model, reasoning, and mode configuration

The composer's menu has Agent, Model, Reasoning, and Mode submenus. A draft can select
any provider configured on its machine; an existing Session keeps its saved
provider identity. Users can change the model between turns in the same Session;
the conversation and provider identity remain unchanged. Available models,
efforts, and modes come from that provider's ACP select options, including
grouped options. Mode names and descriptions retain the provider's wording:
they can describe permission policies or workflows such as Plan, and are not
mapped onto a shared permission scale. A provider that offers no mode choices
has no selectable modes. Draft discovery resolves the selected provider's current
launch settings and creates a temporary provider session in the Workspace's
default directory, without sending a prompt or allocating a managed Session.
The composer supplies a random `probeId` to reuse that connection for successive
choices. The daemon scopes it to the verified user and login session, and checks
the provider, Workspace directory, and launch settings on each request. Requests
without a probe ID remain one-shot discoveries.

Public provider metadata includes a random registry revision that changes only
when settings change or the daemon reloads them. The UI uses that revision for
invalidation; ordinary catalog/history notifications do not restart probes.
The revision is not derived from credentials or environment values.

Changes on one probe run sequentially. The model picker can show a pending model
while the provider confirms its dependent effort and mode options; sending a
prompt and editing dependent choices wait for confirmation. Rapid model choices
keep only the latest queued change. Failed changes retain the UI's last confirmed
choices and discard the probe, so partial provider mutations cannot leak into a
retry. An explicit reload creates a fresh probe with the provider's defaults.

The composer releases its probe on unmount or context/settings changes, using
the same configuration method with `release: true` (which returns `null`). A
pending request settles before that release is sent, avoiding a late request
reopening a retired probe. The daemon closes probes after 60 seconds idle, replaces
them after five minutes, and limits retained/closing probes to eight per machine.
If a retained probe expired, an edit's `restore` selection seeds the new session
from the last confirmed choices before applying the edit. The provider still
validates those choices and reports any unsupported value; reload clears them.
Each request retains the 45-second deadline. Provider settings changes and daemon
shutdown close probes; a changed Workspace directory replaces its probe on the
next request. Launch settings and environment values stay outside the
configuration response and journal.

For agents that advertise ACP `modes` separately from configuration options, the
stdio transport presents that catalog as a mode select option and routes changes
through `session/set_mode`. A native mode configuration option takes precedence.
`current_mode_update` notifications update the same confirmed configuration used
by attached clients and resume. Normalized mode metadata retains its native setter
identity when a resumed process omits the catalog. No catalog is inferred from a
provider's name.

Provider capabilities determine which controls are available:

| Provider | Native modes | Model changes within a Session |
| --- | --- | --- |
| Codex | The bundled adapter offers Read-only, Workspace access, Auto review (Approve for Me), and Full access through its mode option. | Uses the advertised model option. |
| Claude Code | The bundled adapter offers Manual, Accept edits, Plan, Auto, and Bypass permissions where available. Auto can fall back for an unsupported model. | Uses the advertised model option; the returned configuration can also change the effective mode. |
| Cursor | Uses advertised ACP modes, including its documented Agent, Plan, and Ask workflows. These are not its Auto-review permission setting. | Uses model choices advertised by the installed CLI. Initialization requests parameterized model options so reasoning effort is separate from fast variants. Available choices depend on that CLI version. |
| Grok | Current upstream session setup advertises no mode catalog. Its startup Auto/YOLO settings are not exposed as a Session mode selector. Reasoning levels carried beside the model are not Session modes. | Model and reasoning options support changes. A model that does not advertise adjustable effort leaves the reasoning control unavailable. |
| Pi Coding Agent | Thinking levels are reasoning choices, not permission modes. | The bundled adapter advertises model and thinking-level configuration options and supports changing both. |

These are integration observations, not hardcoded option lists. See
[Codex permission modes](https://learn.chatgpt.com/docs/permission-modes),
[Claude Code permission modes](https://code.claude.com/docs/en/permission-modes),
[Cursor ACP](https://cursor.com/docs/cli/acp), Cursor's
[model configuration and variant limitations](https://forum.cursor.com/t/cursor-cli-acp-reports-grok-4-6-fast-despite-explicitly-selecting-the-listed-non-fast-model/174835/5)
and [Auto-review limitation](https://forum.cursor.com/t/acp-agent-doesnt-use-auto-review/171082),
and Grok's [session setup](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs)
and [configuration handler](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/handlers/config_option.rs).

Cursor initialization advertises `clientCapabilities._meta.parameterizedModelPicker`.
When the CLI honors it, reasoning effort is a `thought_level` option and changes
with `session/set_config_option`. Fast remains a model setting. Grok uses that
same option when it advertises one (`reasoning_effort`, `effort`,
`thinking_intensity`, or `thinking_level`, with or without `thought_level`).
Older Grok sessions omit config options and report levels on
`models.availableModels` (`supportsReasoningEffort` and `reasoningEfforts`, or
the thinking-intensity aliases) or on `x.ai/sessionConfig` rows whose category
is `mode`. Deskfleet projects those levels into the reasoning control. A
projected effort change calls `session/set_mode`; a projected model change
calls `session/set_model`. Those metadata rows are not permission modes. An
advertised reasoning option that already uses category `mode` is presented as
`thought_level` and still changes with `session/set_config_option`, so it does
not hide a real permission mode. An
explicit `supportsReasoningEffort: false`, or an empty effort list, leaves the
control unavailable instead of reusing a stale catalog.

New Session commands carry optional model, reasoning, and mode selections. Startup
applies the model first, then an effort and mode supported by that model, before draining
the backlog. Confirmed configuration is retained as ACP `config_option_update`
events and restored when the provider resumes. Until initial configuration
succeeds, ordinary startup retries retain the choices from the create command.
When an ACP response omits its optional configuration list, startup uses options
received while opening the provider session or the last confirmed catalog. Saved
values are reapplied to the provider rather than assumed to describe its current
state. An explicitly empty list remains authoritative; after a failed startup,
an empty cache still permits discovery of replacement choices. Discovered option
metadata is retained for an explicit replacement if startup again omits its list.

Reading configuration does not start or resume the managed Session. After a
failed startup, it offers the provider's available choices while retaining the
saved selection for display. If those choices are no longer in memory, a
temporary discovery session retrieves them without delivering queued inputs or
changing the saved configuration. An explicit replacement overrides the failing
selection during startup; choosing another model lets that model supply its
default reasoning effort unless the user also specifies an effort.

Mode changes use the provider's confirmed configuration, including any fallback
it applies for the selected model. Model changes in a running provider accept
the returned mode rather than reapplying the previous mode. A stopped Session
restores its saved mode along with its model when starting the next provider
process. A retained draft probe likewise accepts the provider's returned effort
and mode when changing models. ACP has no universal reset-to-default setter:
an explicit reload opens a new probe to retrieve fresh defaults.

Changing configuration is an audited, idempotent Session command; it resumes a
stopped provider if needed.
Changes require no active turn and pause backlog dispatch while the provider
confirms the options. Attached clients project the committed updates,
so a change from another client is reflected in an open selector.
Notifications received during startup configuration or an explicit change cannot
overwrite the confirmed response. A queued notification from before a newer
configuration operation is also discarded. Later unsolicited provider updates,
such as slash-command changes, remain visible and are saved for resume.

## Replay, recovery, and UI

Subscribe installs an event buffer before reading the consistent snapshot. The
response precedes buffered/live events. The client uses `session.lastEventSeq`
as its snapshot watermark, reads earlier history in pages, deduplicates by
Session/sequence within the catalog, and fills gaps before applying later events.
Pending permissions are reissued on attachment with changes during the snapshot
read accounted for. User questions are restored from the same snapshot and event
stream. Buttons depend on the current persisted request state.

Conversation text, thoughts, tool cards, plans, and turn outcomes are journal
projections rather than separate message tables. Use provider message IDs when
available; otherwise group consecutive same-role chunks within a turn by their
committed sequence. Entry IDs derive from the first event sequence, so replay
never depends on render timing. Apply tool patches by run/tool-call ID and their
field-presence semantics. Display submitted user content once by input ID and
ignore provider user-message echoes.
The renderer groups the output after each user message into a response. A
finished turn folds its tool calls, thoughts, and interim messages behind its
duration and leaves its final message visible. Answered permissions are shown
on their tool call; only pending ones offer choices.

The shared renderer store survives route changes. It separates connection status
from Session/run/turn state and retains drafts during navigation. Response loss
leaves a visible operation with its original UUID; checking the result queries
the daemon instead of blindly submitting again. Receiving an accepted input
clears only the matching draft, preserving edits made while sending.

The Changes tab reads live Git state through the same connection. Its polling
belongs to the visible panel and pauses when the window is hidden. After each
completed read it waits 1.5 seconds before refreshing status and the selected
file's diff; equal status letters or line counts do not suppress a content
refresh. Switching Sessions discards late results from the previous context.
Read failures retain the last result with an error until a successful refresh.
These snapshots are independent of the conversation journal and its cursors.

Daemon restart marks lost live runs/turns interrupted, outstanding dispatches
uncertain, and old permissions and user questions cancelled. Pending inputs remain queued until
the next message resumes the agent. SQLite commit and provider dispatch cannot be one transaction;
unknown delivery therefore cannot be automatically repeated. Viewer reconnect
only subscribes and replays: it never starts or resumes a provider.

Resume uses the saved provider Session ID and captured directories. Agents that
advertise `session/resume` continue with that method. Agents that instead
advertise `loadSession`, including Cursor CLI and Grok, continue with `session/load`.
That method replays the provider's history as session updates. Deskfleet already
keeps the journal, so it retains configuration updates from the replay and does
not record the rest. The stored `resume` capability means either method was
negotiated. Providers that advertise neither cannot resume.
Stop can close a connection while startup RPCs await;
resume waits for old shutdown/recovery, and old-generation callbacks cannot
interrupt the new run.

## Validation and remaining boundaries

`mise run check` covers native transaction constraints, daemon orchestration,
ACP provider fixtures and the installed steering patch, DataChannel framing and
backpressure, real native two-client WebRTC, and renderer interaction/projections.
`mise run desktop:smoke-agent` adds the production Electron renderer, real local
signaling/WebRTC, SQLite and managed Git worktrees with an injected provider.
The smoke covers creation, streaming, backlog/steering, shared approvals and user questions,
navigation, client replacement, live Git status and diff previews, and daemon
restart without using paid inference. File changes made outside the provider
also update an open diff when their status letters and line counts stay equal.

Remote account enrollment, scoped peer authorization, HTTPS cached history,
central synchronization, and attachments are subsequent work. Synchronization
will use qualified Session IDs and event watermarks; the executing daemon
remains the single journal writer.

The first backend release synchronizes Agent conversations, tool history, audit,
and archive/restore state to PostgreSQL. Archive preserves all content locally
and in central replicas. Permanent user-facing Session deletion is deferred.
When added, deletion removes central conversation/tool content and
content-bearing audit parameters/results, retaining metadata-only audit; stale
uploads must not restore that content. Local durable receipts continue to serve
the existing idempotency contract. See [backend implementation scope](backend.md)
for the delivery plan; attachments remain outside that first backend scope.
