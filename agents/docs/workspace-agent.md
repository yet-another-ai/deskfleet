# Machine-scoped workspace agents

In **Settings → Preferences**, turn on **Super Agent** to use project conversations on this viewing device. An upgrade opens the existing session interface by default. Switching the mode off restores that interface.

On Electron and the native Workspace Agent iOS client, each compatible registered machine exposes a personal default conversation and
one conversation for each catalog workspace. Sending a message (including an explicit
reply) is the only user trigger. A workspace has no idle supervisor process. A
read-only question can stay in the current conversation with evidence from another
registered workspace. A requested modification belongs to the destination workspace.
The source message, destination message and handoff context are committed together.

The desktop sidebar groups projects by machine. The desktop home starts in the
local default conversation or offers local enrollment. The plus button in each machine header opens the New project directory picker
on that registration, even when the machine is collapsed. Workspace names share
a left edge, with session disclosure controls at the right. Confirming creates a
workspace named for the directory and opens its conversation. Directories can
be shared by multiple project IDs with independent conversations. Worker
sessions are created on demand and folded under their project. Existing sessions
with a known project appear there, and visible sessions without a matching
project appear in that machine's unassigned group. A user's private default
workspace has its own worker list. Machine-level MCP catalog and session tools expose ordinary
projects and omit personal default Worker directories, including when addressed by ID. A Worker
already scoped to its own default workspace keeps its normal delegation scope.
Unassigned sessions retain their session composer. Project windows use the project name for their
title; opening the Worker uses its session title.
Archived sessions remain in the existing archive. In Preferences, **Organize by directory** previews the signed-in user’s active, unassigned directory sessions on the selected machine. Confirm a group to link it to a project with the same directory bindings, or create a project there. If multiple projects share the directories, choose one explicitly. Skipping keeps the original sessions accessible. Links belong to the signed-in user on the original machine registration. Directory contents, journal records, provider session IDs, message history, and archive flags are preserved. The project sidebar displays the registration ID beside duplicate machine names. Independent app installations retain separate histories even when their hostnames match.

On iOS, home opens the selected machine’s default workspace. On first use,
choose a machine if several compatible registrations are available. The choice
belongs to this account, server and team. An offline machine keeps its selection
and project drafts. The selected machine serves projects, tickets, Worker sessions,
files and provider settings. Returning to the foreground refreshes the project
snapshot. Model and Worker approval settings open in a touch sheet.
See the [native build instructions](../../apps/web/README.md) for the separate iOS development identity.

Right-click (or long-press on iOS) a Worker in a project or personal default workspace and choose **Copy ID**.
Paste the address into the project's Super Agent composer and add a task or attachment
to send it to that exact DeskFleet session. The address includes the team, machine
registration and session ID. The host validates the sender, registration, project and
any quoted ticket before delivery. A personal default workspace can hand the request
to the addressed project on the same machine. One message can address one Worker.
A host that lacks this capability cannot accept an addressed draft.

An Antigravity execution provider exposes the standard Gemini model table in the project execution model menu. Selections apply to new Workers in the project. Opening an existing Worker uses its own model controls.

The conversation header counts active tickets in the current workspace.
Its button opens a popover at the header, independent of the conversation's scroll
position. Expanding a ticket shows its scope, latest result or progress, and
linked Worker session when one exists. A successful Worker turn clears the
ticket's status. Its result stays in the conversation and the ticket can be
continued, including by quoting that result.

Expand a ticket to archive it. The header's collapsed **Archived** group lets
you restore it even if the active count is zero. Each ticket owns at most one
Worker. Once bound, both entries use the original Session archive and restore
commands, including worktree cleanup, and changes made in either UI appear in
both. A ticket with no Worker yet stores its archive flag in the existing ticket
record. Assignment must settle or be stopped first. Archived tickets keep their
messages, leave scheduling and foreground focus, and must be restored before
they can receive another instruction. Restoration does not dispatch work.

Project and Worker navigation carries machine and team identity so equal numeric
IDs on two machines are independent. On an older remote daemon, ordinary catalog
and folder operations are available when the machine is online. Its project
conversation explains that the host needs an update. The regular browser and Android client keep their
existing session entry. On macOS and iOS, the project and default conversations show
their Workers' outstanding tool approvals, plans and structured questions above
the composer. Each card names its ticket and uses the same controls as the Worker
detail page. Tool approval records in the conversation share one collapsed row per
Worker turn. Expanding it reveals the original requests and their message actions.
Older receipts without a turn ID are grouped within that Worker's result boundaries.

The project and default conversations share the Session composer. Its upload menu
and file picker target the selected machine. Pasting a screenshot or a long text,
typing multiple lines, and system dictation feed the same project draft as typing.
An explicit reply stays attached to the message while the host chooses its Ticket.
The sender checks the host's attachment capability before submitting a draft with
files. Older hosts can still receive plain text. The daemon stores submitted material under the
registration and sender. A machine file must either belong to the project roots
or have a file selection grant from the authenticated Files channel. The
coordinator receives bounded text previews or vision inputs, a dispatched
Worker receives the original content blocks, and snapshots carry display metadata.
Projects with a catalogued GitHub repository open the shared Issues and Pull Requests
panel from their header. Inserting or dropping an item places its title, link and
description into the current project draft. The Worker's session keeps its own draft.
The timeline reads one attachment from the sender's room by message ID and index.
`WorkspaceMessageAttachment.vue` loads nearby images and pasted text into
`AgentContent` and opens a selected file in `AgentResourceViewer`.
The read serves the saved copy, hides its filesystem location, and uses the
same 16 MiB preview limit as remote files. Regular refreshes fetch only metadata.

## Project execution settings

The project and default workspace composers have a single model menu beside the
add button. The coordinator and execution provider each have their own optional
model and reasoning choices. Both menus use the providers registered on the
target machine. A provider can coordinate only when its adapter supports a
tool-free routing call. Coordinator settings apply to the user on this
machine registration. Execution defaults apply when this workspace creates a
Worker. A specific Worker's session retains its own model selector, approvals,
context usage and worktree changes.

Under the execution provider, **Agent mode** selects a native mode advertised by
that provider. Changing the execution provider clears the selected mode.
**Tool approvals** controls DeskFleet's own automatic approval of tool permission
requests. It defaults to manual and requires confirmation to turn on. Both
defaults belong to the signed-in user's project on this machine, including a
separate setting for their default workspace. Worker creation uses the ordinary
Session configuration and auto-approval flag. Existing and adopted Sessions keep
their settings. Structured questions and plans still go to the user.

Coordinator choices arrive in the workspace snapshot. Opening the model menu
starts loading the execution provider's choices for the selected workspace and
model. The execution controls share that read and reuse its result on reopening.
Changing the provider registration or project directory invalidates the result.
The execution adapter can report a different model list from the coordinator.

Workspace context usage is the last measured coordinator inference for this
workspace and configuration. When the provider reports enough information, the
popover shows tokens used and capacity. A call without a reliable limit can show
used tokens alone. Quoted messages and the current ticket continue to inform
routing independently of the model menu.

## Shared conversation UI

Use the regular Session components for common display and interaction changes.
A personal workspace message has its own ID, sender and acceptance timestamp. The
workspace adapter maps an acknowledged user message to `AgentUserMessage`. Its
header resolves the account nickname and avatar and displays the localized time
and input delivery icon. Routing, queueing and execution have their own progress on
the Agent side. Legacy personal-room snapshots use the signed-in user's profile
when the host omitted an author. A Worker reply resolves Markdown file links
against its producing session and machine.

| Surface | Shared implementation | Workspace-specific behavior |
| --- | --- | --- |
| Messages and actions | `AgentUserMessage`, `AgentContent`, `AgentMessageActions` | Quote by message ID. The ticket disclosure contains reassignment and execution-session navigation. Fork acts on the eligible Worker result. |
| Reading | `ConversationList`, `UiScrollArea`, `AgentOutline`, `ReadingSpotlight`, `ScrollToBottom` | The outline uses the workspace transcript and associates a reply with its originating message. Reading position is scoped to the account, team, registration and project. |
| Input | `SessionComposer`, its keyboard handling, attachment pipeline and completion menu | The project selects coordinator and execution settings. Commands and skills target the selected Worker provider. Normal messages retain automatic routing. |
| Sidebar and Worker detail | `PinnedSessions`, machine terminal action and the original Worker configuration selector | The machine owns the project. The pinned group can be expanded when populated, and opening a project terminal uses the project directory. |
| Attachments | `AgentContent` and the existing resource viewer | Routine snapshots carry names and types. A compatible host resolves the requested attachment against the authenticated user's stored message. |

Typing `/` discovers the active execution provider's commands. Browsing the
menu requires no new session. Sending a listed command preserves its literal
text and arguments. An explicitly quoted Worker takes precedence over the current
ticket. With neither, sending creates a Worker for the workspace. `@` lists
available file and session references, and `$` lists the execution provider's
skills. Before dispatch, the host validates the selected references and provider.
A literal filesystem path can still be sent as text.

## Code map

| Owner | Entry |
| --- | --- |
| Workspace page, message actions and correction controls | `packages/components/src/views/WorkspaceAgentView.vue`, `packages/components/src/services/workspace-message-timeline.ts`, `useWorkspaceConversation.ts` |
| Provider command and reference completion | `packages/components/src/composables/useWorkspaceCommands.ts`, `packages/components/src/components/composer/useComposerCompletions.ts` |
| Coordinator and execution model menu | `packages/components/src/components/composer/ProjectModelMenu.vue`, `apps/daemon/src/super-agent-profiles.ts` |
| Registered coordinator adapters and DeepSeek inference | `apps/daemon/src/super-agent-provider.ts`, `packages/dsh-runtime/src/helper.ts` |
| Coordinator usage measurements | `apps/daemon/src/super-agent-usage.ts`, `packages/components/src/components/composer/AgentUsage.vue` |
| Device mode, optional directory grouping and authenticated ownership | `packages/components/src/components/settings/WorkspaceAgentSettings.vue`, `apps/daemon/src/super-agent-history.ts` |
| Machine-scoped project entry, folder selection and navigation | `packages/components/src/views/WorkspaceEntryView.vue`, `NewProjectView.vue`, `components/sidebar/MachineSection.vue` |
| Scoped renderer API | `packages/components/src/composables/useMachineRuntimes.ts`, `packages/client/src/desktop-api.ts` |
| Granted peer RPC and wire contract | `apps/daemon/src/authorized-peers.ts`, `agent-channel.ts`, `super-agent-protocol.ts` |
| Host decisions, focus, private state and worker receipts | `apps/daemon/src/super-agent-service.ts`, `super-agent-state.ts`, `super-agent-worker.ts` |
| Ticket archive projection and native Worker lifecycle | `apps/daemon/src/super-agent-archive.ts`, `apps/daemon/src/agent-sessions.ts` |
| Stop a request or one of its branches | `apps/daemon/src/super-agent-stop.ts`, `packages/components/src/components/session/WorkspaceReplyProgress.vue` |
| Worker address format, origin and explicit routing | `packages/client/src/worker-reference.ts`, `packages/client/src/desktop-api.ts` (machine target), `apps/daemon/src/super-agent-target.ts` |
| Candidate selection, bounded file/history evidence and inference | `apps/daemon/src/super-agent-router.ts`, `super-agent-evidence.ts`, `super-agent-model.ts`, `super-agent-codex.ts` |
| Registration storage and private default execution directory | `apps/daemon/src/super-agent-store.ts`, `super-agent-workspaces.ts`, `crates/store/src/super_agent.rs` |
| Live self-hosted acceptance | `scripts/smoke-workspace-agent.ts` |

## Ownership, routing and recovery

The signed peer grant determines origin, Team, machine, user and device. Local calls use the authenticated local channel. Compatible remote targets use the existing Agent WebRTC channel.
A peer must have agent read permission to read snapshots and execution permission
to modify them. The daemon rechecks delegated user authority before inference and
execution. Desktop exposes remote project operations only on a machine advertising the capability. The central
API continues to enforce Worker quotas and its existing session synchronization.
User front-desk data is local to the registration SQLite database. Content used for
inference is passed to the explicitly selected coordinator, including any retrieved
evidence. Worker input and history follow the existing DeskFleet data path.

The SQLite migration adds one revisioned state row for each user. Each row stores
the workspace conversations, replies, ticket ownership and scope, recent user
focus, runtime bindings, history citations, and the dispatch ledger. A host update
uses a copy of the committed state and a compare-and-swap database write. The
user message ID deduplicates client retries. A dispatch has separate persisted
create and input command IDs. Recovery checks the native journal before advancing
an interrupted operation. An uncertain delivery stays visible. Project snapshots
include outstanding requests from their tickets' own Worker journals. A user's
choice goes directly to the original Session decision command with its request
and operation IDs. The first valid decision is shared across clients. Project
history records the outcome without copying form answers. Late Worker events
update the owning ticket without taking over the user's current discussion.

The host returns configured provider IDs, names and coordinator availability in the workspace snapshot.
The timeline shows copy and quote actions on messages. Expand a message's ticket
title to open its Worker session or change the originating request's ticket
when another ticket is available. Message details start collapsed.
The latest identifiable Worker result also links to the existing
[Fork session dialog](agent-sessions.md#forking-a-conversation). The Worker
checks that the selected turn is still its latest turn before forking.
Confirming opens the child under the source Worker's project. Cancelling
returns to the project or default workspace where the dialog was opened.
Live routing and execution progress appears in the agent reply, or in
a temporary agent row while waiting for the first reply. The final result clears
that request’s progress. Split requests retain progress for unfinished tickets.
On compatible hosts the empty composer and each Agent progress row can stop a
request directly. With several requests the composer asks which one to stop.
A split request can stop all unfinished branches or one named ticket. A draft
keeps the send button and the inline stop remains available.

The host resolves the original user message and revision, including a handoff.
Stopping routing aborts that decision and fences off late dispatch. A stop of
an assigned branch is saved on its existing dispatch intent. For a queued
Worker input the host uses `_deskfleet/input/withdraw`; for an actual turn it
uses `_deskfleet/turn/cancel` with its journal ID. A delivered steer shares the
original turn. Single-request cancellation uses the optional `requireUnshared`
guard inside the Worker's existing journal transaction. A steer that arrives
after cancellation starts can run on its own next turn. Pending approvals close
through the same Worker cancellation.
A claimed input cancelled before provider admission is withdrawn without consuming a turn.
The terminal journal outcome wins a race with natural completion. If delivery
or cancellation cannot be confirmed, the conversation reports that uncertainty.
Partial output and completed work remain available for follow-up.
Dispatch markers and delivery notices still supply recovery controls on the
source message. Previous records without a marker type are recognized as well.
If a Worker is missing before the workspace checkpoint, no create or submit
command has run. After configuring a provider, explicit retry reuses the ticket,
prompt and original operation IDs. The host checks for newer work on that ticket
and skips already delivered siblings. Retrying a delivery never reruns the coordinator.

A reply identifies a discussion and a default owner. A revision to the same deliverable can update its latest acceptance criteria while preserving the original authority. A new deliverable or an
expanded authorization can create a linked ticket. An unquoted reply can continue
the foreground question. Exact replies to suitable registered options have a
deterministic fast path. For other input the coordinator sees a compact directory,
selected cards and recent dialogue. It can ask the host for bounded evidence.
The host validates workspace, ticket, session, provider, file roots and active turn.
The default execution workspace is created lazily and is excluded from cross-project
reading. Existing DeskFleet sessions are considered on demand within their project.
Archived or dirty historical execution contexts require manual inspection.

The coordinator preference applies to the signed-in user across this registration.
Each workspace separately selects its default Worker. Coordinator selections refer
to a provider registration ID. If an explicitly selected provider is missing, or several registrations
match the default, the user chooses a coordinator before sending work that needs inference.
The Codex coordinator supports macOS with Codex CLI 0.170.0 or 0.171.0. Other
CLI versions require verification of the outgoing request before they can coordinate. Its default is gpt-6.2-sol with low effort. Its ephemeral process disables execution tools,
uses a restricted model catalog, and excludes user/project instruction files.
Protocol tests inspect the complete outgoing tool declaration, including incremental
tools. Claude Code runs a restricted, nonpersistent structured-output invocation.
The bundled DeepSeek Harness uses its configured model and credential route for
structured inference without starting a Worker session. For a registration that shares the host's
DSH desktop model settings, both role pickers offer its configured model routes.
Each qualified selection keeps the provider and model together. New Workers and
the coordinator follow the available desktop default unless explicitly overridden.
The DeepSeek Harness plugin in `packages/agents/deepseek-harness` resolves the
registration environment for both launches. The daemon watches opted-in desktop
profiles and invalidates the configuration cache when they change.
See [DeepSeek Harness registration settings](agent-sessions.md) for credential scope. A failure retains
the original message for explicit retry. Switching coordinator never resends it.
The initial layout supports a personal workload. Persisting and returning whole
conversation snapshots means storage and transfer costs grow with retained history.

## Build the independent macOS variant

Use the repository's pinned toolchain. Build the native binding and desktop bundle
against the intended account endpoint. The ordinary development build defaults to
the local backend on port 8080. The public desktop release embeds
`https://deskfleet.yetanother.ai`. A self-hosted build must supply its own URL.

```sh
mise run native:debug
VITE_DESKFLEET_SERVER_URL=https://deskfleet.yetanother.ai mise run desktop:build
cd apps/desktop
mise exec -- node scripts/stage-native-viewer.ts
build_dir=$(mktemp -d)
mise exec -- pnpm exec electron-builder --config electron-builder.super-agent.yml --config.mac.identity="${DESKFLEET_MAC_SIGNING_IDENTITY:?Set a Developer ID Application identity}" --mac --arm64 --dir --publish never --config.directories.output="$build_dir"
bundle="$build_dir/mac-arm64/deskfleet-workspace-agent.app"
codesign --verify --deep --strict "$bundle"
codesign -d -r- "$bundle"
```

The variant requires a Developer ID Application identity from the selected
Apple team. The packager signs the helpers and outer bundle together. For an
independent fork, set `DESKFLEET_MAC_SIGNING_IDENTITY` for the first build
and keep that team and bundle ID on updates. Verify that the
designated requirement matches the previous certificate-signed build. The first
transition from an ad-hoc build can prompt for the login keychain's Safe Storage
item. **Always Allow** authorizes this signed application for that item.
On a slow Mac launch, the main window shows a local status message while the
host initializes. The project renderer opens in that window after IPC is ready.
If the saved account cannot be read, the user can retry or open the normal
sign-in page. Both actions preserve the saved file. A successful new sign-in
replaces it atomically.
A local temporary build directory avoids extra Finder metadata from cloud-synced folders.

The independent variant has a distinct bundle ID, application profile, keychain
identity and update policy. It can run alongside the original installation.
Accounts and local front-desk state are established within its own profile.
A fresh registration has its own session catalog. The app does not clone a live
registration or copy credentials from the original app.

## Verification

Run daemon tests matching `super-agent-*.test.ts`, the authenticated local channel
tests, the renderer workspace view tests, and the migration/store tests. With a
disposable PostgreSQL database, build `deskfleet-server` and run:

```sh
TEST_DATABASE_URL=postgresql://localhost/deskfleet_test node scripts/smoke-workspace-agent.ts --journey
```

The journey uses real sign-in, Team enrollment, local grants, a Codex coordinator
and a real Codex Worker in temporary A and B directories. It checks that a default
read creates no ticket, transfer copies original input exactly once, and an
unquoted follow-up modifies the same file through the same ticket and session.
`--codex-router --claude` selects a real Claude Code Worker. `--fixed-route`
isolates Worker behavior from coordinator availability. These live tests use the
configured model accounts and can consume provider quota.
