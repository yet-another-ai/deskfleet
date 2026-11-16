# Control-plane verification

This document owns executable checks for the asynchronous peer control plane.
[WebRTC security](webrtc-security.md) owns authorization decisions.
[Architecture](architecture.md) owns component boundaries, multi-instance
routing, and the remote transport. [Environment](environment.md) owns the
toolchain tasks once they exist. [CI](ci.md) owns how a change selects jobs.

The models cover the Actix server, the machine daemon, and the Electron, Web,
and mobile clients. They live at the repository root in `specs/`, beside
`apps/`, `crates/`, and `packages/`. `PROTOCOL_VERSION` stays at `1`. A model
changes in place with the decision it checks; it does not keep a compatibility
layer for an earlier provisional shape.

## What a model is for

A model checks interleavings of grants, signaling, link liveness, routing, and
Mux stream lifetime. The prose documents remain the decisions. A model is updated in the
same change as the decision it can violate. A refactor that preserves those
decisions leaves the model alone. Codecs, byte budgets, file layout, and
catalog or history behavior are outside that rule.

The edit loop is the Quint simulator. Symbolic checking is a separate local
task, run when a module's actions change, and it stays off `check`,
`check-fast`, and `ci:preflight`. A green simulator or verifier says the model
satisfies its invariants. The TypeScript and Rust tests remain the evidence
for the implementation. A counterexample becomes a named `run` in the model.
It becomes an implementation test only when that trace can occur in the
running code. The repository does not generate TypeScript or Rust from Quint,
and CI does not diff implementation traces against the model.

## Toolchain

Quint is a mise tool, installed with the pnpm already pinned in `mise.toml`.
It is not a workspace dependency and does not enter `pnpm-lock.yaml`.

```toml
min_version = "2026.11.1"

[settings.npm]
package_manager = "pnpm"

[tools]
"npm:@informalsystems/quint" = "0.33.1"
```

Raise `min_version` to at least `2026.11.1` in the change that selects the
pnpm installer. Mise 2026.10 installs pnpm 11+ global tools with links outside
`MISE_DATA_DIR`. CI restores only the mise tool cache, so `quint` then fails
to start. Mise 2026.11.1 keeps that install inside the tool directory. If the
repository already requires a newer mise by then, keep the newer floor.

The tool id uses the npm backend. pnpm is the installer, so the setting
applies to every later `npm:` tool. `mise.lock` records the Quint version.
The pnpm installer resolves Quint's own dependency tree at install time; the
introducing change runs `mise lock` and commits `mise.toml` with `mise.lock`.
Renovate's mise manager stays disabled, so later bumps are manual.

`spec:test` needs Node, which mise already provides. `spec:verify` uses the
existing Temurin 21 and the Apalache release Quint downloads for
`@informalsystems/quint` 0.33.1. The simulator does not wait on a JDK change.
If that Apalache release refuses Temurin 21, record the JDK bump on
`spec:verify` alone.

## Layout and commands

Each module is one file under `specs/`. The Quint module name matches the
file stem. Constants sit at the top of the file. A shared constants module
waits until a second file would otherwise copy a definition it must keep
identical.

| File | Constants | Verify bound |
| --- | --- | --- |
| `specs/grant_lifecycle.qnt` | 1 client, 1 daemon, 2 peers | 6 steps |
| `specs/route_fence.qnt` | 2 API nodes, 1 registration, 2 peers | 6 steps |
| `specs/mux_streams.qnt` | 1 peer, 2 logical streams | 6 steps |
| `specs/link_liveness.qnt` | 1 client socket, 1 daemon socket, 1 peer, 2 identities each | 6 steps |

Deadlines are actions (`reservation_due`, `authorization_due`, `setup_due`,
`link_dead`), not counters. Changing a duration in the prose leaves the model
unchanged. Changing which event closes, preserves, or replaces a peer updates
the action.

`mise run spec:test` typechecks and simulates every `specs/*.qnt`:

```sh
quint typecheck "$spec"
quint test "$spec" --max-samples 200 --seed 1 --match '^(?:<run names>)$'
```

Quint's default test filter executes only definitions whose names end in
`Test`. `scripts/check-specs.ts` selects every `run` in the file instead, so
the witness names below stay free of that suffix.

The task fails when `specs/` contains no model, so deleting the last file
cannot pass. A disabled step is written `action.fail()` and is the last step
of its run: Quint does not carry state past `fail()`. While editing one
scenario, narrow it with
`quint test specs/<file>.qnt --match <run> --max-samples 20 --seed 1`.
The committed task keeps the shared seed and the full sample count. A seed
that exposes a real invariant failure is added as its own named `run`; the
task does not accumulate extra seeds.

The simulator backend stays Quint's default TypeScript runner. The Rust
runner is a later switch only if `spec:test` exceeds the budget below.

`mise run spec:verify` is local. Each module is listed explicitly and passes
its invariants with `--invariants`, so a failure names the predicate:

```sh
quint verify specs/grant_lifecycle.qnt --max-steps 6 --invariants <names>
```

Start at 6 steps. `route_fence`, `mux_streams`, and `link_liveness` finish in
seconds. `grant_lifecycle` takes about 5 minutes. Apalache rejects an inductive
check of its maps because the next-state value is unconstrained. Splitting
the module would drop the interleavings its invariants exist to check, so
the task keeps the 6-step search. Raising the step bound is not the
response to a slow or inconclusive check.

## Shared fault model

These actions stay enabled in every module that can observe them. A new
message is a new action; the fault actions stay.

| Action | Effect |
| --- | --- |
| `signaling_down` / `signaling_up` | The socket is gone or replaced. An established, unexpired grant remains usable. Reconnect does not write a later `expiresAt`. |
| `crash_before_activate` | A reserved grant is not activated after the reserving process dies. |
| `drop_inbox` | Inbox delivery is at-most-once. A lost negotiation is retried as a new `peerId`. An exact retry of the same offer reads the stored result. |
| `lease_lost` | That API process's local sockets stop being authority. |
| `late_message` | A response or disconnect cleanup carrying a replaced connection identity does not affect the new route. |
| `duplicate_delivery` | Delivering the same stored offer, answer, or candidate again does not create a second binding. |

## Grant lifecycle

`specs/grant_lifecycle.qnt` is the state of one grant: `reserved`, `bound`,
`answered`, `established`, or `closed`. The record holds actor, transport
(`local` or `webrtc`), fingerprints, and the activation and expiry deadlines.
A separate binding holds actor, transport, and the offer and answer
fingerprints. Only reservation and the first offer or answer write it.
Target, Team, purpose, and actions stay in the authorization prose; this
module does not vary them. A separate boolean records that an accepted Agent
task or shell is still running.

| Action | Rule |
| --- | --- |
| `request_grant` / `activate` | Activation writes the full expiry and only from a reservation that is still inside its lease. Requesting a grant, submitting an offer or answer, and trickling ICE require the signaling connection. |
| `reservation_due` / `crash_before_activate` | The reservation can no longer be activated. |
| `submit_offer` / `submit_answer` | The first offer and answer write the binding's fingerprints. Reservation writes actor and transport. Later actions leave that binding unchanged. A different offer or answer requires a new `peerId`. |
| `trickle_ice` | Candidates attach to this peer's one negotiation, including candidates that arrive before the description. |
| `relay_refresh` | A refreshed relay allocation does not move `expiresAt`. |
| `signaling_down` / `signaling_up` | An established, unexpired peer stays open. Reconnect does not move `expiresAt`. |
| `revoke` / `authorization_due` | Applying a revocation needs the signaling connection; a revocation that commits while that connection is down is delivered later by route reconciliation. The local authorization deadline still closes the peer during an outage. The Agent or shell boolean stays set. |
| `setup_due` | A negotiation that never establishes fails. The replacement is a new `peerId`. |
| `disconnected_grace` / `failed_immediate` | A transient disconnect waits for `recovery_due`. `failed` and `closed` close immediately. A resumed page opens a new authorized peer. |
| `claim_local` | The one-use secret succeeds once, and only for a `local` grant inside the claim window. A second claim, a claim after close, and a claim of a `webrtc` grant fail. A `local` grant cannot submit SDP. |

Invariants:

- After binding, actor, transport, and fingerprints match the separate binding, and later actions leave that binding unchanged.
- A signaling transition does not close an established, unexpired peer and does not extend its expiry.
- A closed, revoked, or expired peer is not activated or rebound.
- Reservation expiry and a crash before activation both refuse activation.
- The local secret has at most one successful claim.
- `local` and `webrtc` grants are not used on each other's endpoints.
- Relay refresh does not extend the grant.
- Closing the peer leaves the accepted-work boolean set.

Named runs use the same identifiers as the invariants they witness:
`signaling_loss_keeps_established_peer`, `reconnect_does_not_extend_expiry`,
`changed_offer_keeps_binding`, `expired_reservation_cannot_activate`,
`local_claim_is_single_use`, `transports_are_not_interchangeable`,
`relay_refresh_keeps_expiry`, and `expiry_leaves_accepted_work_running`.

| Run | Implementation evidence already present |
| --- | --- |
| `signaling_loss_keeps_established_peer` | `packages/client/src/remote.test.ts` preserves peers during signaling loss. `packages/client/src/files-signaling.test.ts`, `ports-signaling.test.ts`, and `mux-client.test.ts` cover files, ports, and Mux streams. `apps/daemon/src/local-channel.test.ts` keeps an authorized local channel and shell when central signaling is lost. |
| `reconnect_does_not_extend_expiry` | The remote client test above closes authorization at the original 24-hour deadline after signaling loss. The model additionally checks that the reconnect action cannot write a later deadline. |
| `expired_reservation_cannot_activate` | `apps/server/src/peers/shared_tests.rs` `cancelled_creation_holds_only_a_short_reservation_and_cannot_activate_after_expiry`. |
| `local_claim_is_single_use` | `apps/daemon/src/local-channel.test.ts` rejects a second `localOpen` of a live claim. The model additionally checks that closing the socket does not make the secret reusable; a renewal is a new grant. |
| `expiry_leaves_accepted_work_running` | The local-channel test retains the shell across IPC reconnect. Server and client tests cover grant close separately from session lifetime. |

`changed_offer_keeps_binding`, `transports_are_not_interchangeable`, and
`relay_refresh_keeps_expiry` are model runs first. Add an implementation test
only when a verifier trace shows the current server, daemon, or client can
perform that transition.

## Route fence

`specs/route_fence.qnt` is the multi-instance control connection. Each API
node has a lease and a connection identity. PostgreSQL holds the current
route, the immutable offer and answer, and the bounded early-ICE list. The
daemon queue has a reserved reconciliation slot. One registration is in
scope; another Team's connection is a distinct route and cannot replace this
one.

| Action | Rule |
| --- | --- |
| `replace_route` | The new connection identity becomes the route. |
| `late_message` / `disconnect_cleanup` | An old identity cannot deliver, revoke, or clean up the new route. |
| `lease_lost` | The node's local sockets lose authority. |
| `enqueue_offer` / `take_snapshot` | A snapshot whose read is ordered before a grant is enqueued cannot close that grant. A revoked or expired grant in the snapshot is closed. Unrelated established peers stay. |
| `coalesce_reconcile` | Further reconciliation requests collapse into one fresh read after the queued snapshot. The queued snapshot keeps its FIFO position. |
| `peer_event_overflow` | Early ICE waiting for an answer does not block that answer, heartbeats, or other RPC responses. Overflow fails the affected peer through its normal close and leaves the Machine route in place. |
| `drop_inbox` | The caller observes an interrupted negotiation and opens a new `peerId`. Command receipts still decide command retries. |

Invariants:

- The current route has one connection identity. Actions carrying another identity do not change it.
- A snapshot does not close a grant that was enqueued after that snapshot was read.
- Reconciliation closes revoked and expired peers and retains unrelated established peers and Machine presence.
- Coalesced reconciliation does not move an already queued snapshot behind newer commands.
- Peer-event overflow and a full ICE queue do not remove the route.
- A lost inbox delivery does not mutate an existing binding.

Named runs: `stale_identity_cannot_fence_the_new_route`,
`snapshot_before_grant_cannot_close_it`, `missed_revocation_closes_on_reconcile`,
`coalesce_keeps_snapshot_position`, `early_ice_cannot_block_the_answer`,
`overflow_fails_the_peer_only`, and `lost_negotiation_opens_a_new_peer`.

| Run | Implementation evidence already present |
| --- | --- |
| `snapshot_before_grant_cannot_close_it` | `apps/server/src/hub/reconcile_tests.rs` `postgres_reconciliation_repairs_missed_revocation_and_precedes_new_offers`. |
| `coalesce_keeps_snapshot_position` | `apps/server/src/hub/outbox_tests.rs` `reconciliation_uses_reserved_capacity_and_follows_intervening_offers` and `repeated_reconciliation_cannot_move_a_snapshot_behind_new_requests`. |
| `overflow_fails_the_peer_only` | `apps/server/src/hub.rs` `saturated_revocation_requests_reconciliation_and_preserves_machine_presence`. `apps/server/src/websocket.rs` covers transient storage failure and an interrupted handshake, which must not revoke an existing peer. |

The identity, lease, and lost-inbox runs are model runs until a trace shows
the hub or peer routes can apply a stale identity, use a socket after lease
loss, or rewrite a binding after a dropped inbox message.

## Mux streams

`specs/mux_streams.qnt` is one `fixed4-v1` peer and two logical streams.
Stream open and close are not grants. The peer carries the verified actor,
Team, Machine, actions, and expiry. Lanes, credits, and the 16 KiB frame cap
stay in the implementation.

| Action | Rule |
| --- | --- |
| `open_stream` / `close_stream` | Closing one stream detaches that viewer or aborts that file stream's unfinished staging. Sibling streams, the shell, and the Agent process stay. |
| `revoke_peer` / `authorization_due` | Every stream on that peer is released. Accepted work keeps the grant-lifecycle boolean. |
| `unsupported_profile` | An explicit unsupported-profile rejection may select the legacy purpose-specific peer before any business request. |
| `auth_failure` | Authentication failure, revocation, a network timeout, or malformed traffic does not select the legacy peer. |

Invariants:

- A stream action does not change the grant's actor, actions, or expiry.
- Closing one stream does not close its sibling or the peer.
- Peer revoke and expiry release every stream.
- Unsupported profile is the only failure in this module that selects a legacy transport, and only before business traffic.

Named runs: `close_stream_keeps_sibling`, `peer_close_releases_every_stream`,
`unsupported_profile_selects_legacy`, and `auth_failure_stays_failed`.

| Run | Implementation evidence already present |
| --- | --- |
| `close_stream_keeps_sibling` and `peer_close_releases_every_stream` | `packages/client/src/mux-client.test.ts` retains streams across signaling loss and closes all of them on revocation without replaying requests. |
| `unsupported_profile_selects_legacy` and `auth_failure_stays_failed` | The same file rejects missing or mismatched `mux` / `muxServer` markers without requesting a Mux grant, and authentication, network, and protocol failures do not fall back. |

## Link liveness

`specs/link_liveness.qnt` is one client signaling socket, one daemon control
socket, and one already established peer. Each socket has two connection
identities. `generation` stops at 2 so the route stays finite; that bound is
not a product limit. Durations stay in the architecture prose. The client
actions are this module's `signaling_down` / `signaling_up`. The daemon actions
are the same pair for the control link. `late_client` and `late_daemon` are
`late_message`. Reservation, inbox, and lease loss stay in the grant and route
modules because this peer starts established.

A hidden page skips heartbeats, so `link_dead` is enabled only from a visible
socket. Returning while the socket is still inside the idle deadline probes
it. A probe that is answered keeps the identity. A missed probe, a visible
idle deadline, or a resume that finds the socket already idle declares that
client link dead and then replaces only that socket. The daemon does not
suspend heartbeats. Declaring its link dead reports the machine disconnected
and the following reconnect fences the old identity.

Viewer invalidation overflow and a full daemon queue stay in the architecture
prose. This module does not vary them. `route_fence.qnt` already checks
peer-event overflow. `apps/server/src/hub.rs`
`distinct_hint_overflow_reconnects_only_its_viewer_and_keeps_daemon_rpc_live`
keeps the daemon route current and its queue empty.
`saturated_request_reports_busy_without_taking_machine_offline` returns
`machine_busy` and leaves the original command as the only queued message.

| Action | Rule |
| --- | --- |
| `hide_page` | Heartbeats stop. The client identity and the peer stay. |
| `show_page` / `probe_ok` / `probe_miss` | A fresh resume probes the open socket. An answer keeps it. A miss declares that client link dead. |
| `resume_idle` | A hidden socket already past the idle deadline is declared dead without a probe. |
| `link_dead` | A visible client socket is declared dead. A hidden socket does not take this action. |
| `daemon_link_dead` | The daemon reports the control link down. The client socket and the peer stay. |
| `replace_client_socket` | The next client identity replaces a dead client socket. Only this action writes that identity. The daemon route, the peer, and expiry stay. |
| `replace_daemon_route` | The next daemon identity replaces a dead control link and fences the previous identity. Only this action writes that identity. Expiry stays. |
| `late_client` / `late_daemon` | A message carrying the replaced identity leaves the new route, the other socket, and the peer unchanged. |
| `disconnected_grace` / `recover` / `recovery_due` | A transient disconnect can recover. The recovery deadline closes the peer. |
| `failed_immediate` | `failed` and `closed` close the peer immediately, including during the grace window. Signaling identities stay. |

Invariants:

- The client route is one of the three identity shapes `(c1, none, 0)`, `(c2, c1, 1)`, and `(c1, c2, 2)`. The daemon route is the same shape on `d1` and `d2`.
- The client phase is `up`, `hidden`, `probing`, or `dead`. The daemon phase is `up` or `dead`.
- A closed peer records `failed` or `recovery`. An established or grace peer has an empty close cause.
- Expiry stays at the value written for the established peer.

Named runs: `hidden_page_skips_link_dead`, `fresh_resume_probes_before_replace`,
`probe_ok_keeps_the_socket`, `probe_miss_replaces_only_the_client`,
`resume_idle_replaces_the_client_only`, `both_links_down_keep_the_established_peer`,
`daemon_replace_fences_the_old_identity`,
`hidden_client_keeps_the_peer_across_daemon_replace`,
`grace_recovers_without_closing`, `recovery_due_closes_the_peer`, and
`failed_closes_the_peer`.

| Run | Implementation evidence already present |
| --- | --- |
| `hidden_page_skips_link_dead`, `fresh_resume_probes_before_replace`, `probe_ok_keeps_the_socket`, `probe_miss_replaces_only_the_client`, `resume_idle_replaces_the_client_only` | `packages/client/src/http-central.test.ts` skips liveness traffic while hidden, probes a resumed socket, keeps a socket that answers, replaces a socket that misses the probe, and replaces an idle suspended socket on return. |
| `both_links_down_keep_the_established_peer` | `packages/client/src/remote.test.ts` preserves peers during signaling loss. `packages/client/src/http-central.test.ts` reports signaling loss without a peer revocation. `apps/daemon/src/central-client.test.ts` `a silent control link is abandoned after a bounded grace and replaced` reports the daemon disconnected before the replacement socket exists. |
| `daemon_replace_fences_the_old_identity` | The daemon test above replaces the control link. Fencing a late frame on the retired identity remains a model run until a trace shows that frame changing the new route. |
| `grace_recovers_without_closing`, `recovery_due_closes_the_peer` | `packages/client/src/peer-lifecycle.test.ts` `a recovered disconnected state never fails the peer`. `packages/components/src/composables/useDesktopConnection.test.ts` `a transient disconnected state does not tear down a recoverable desktop peer`. |
| `failed_closes_the_peer` | `packages/components/src/composables/useDesktopConnection.test.ts` `native errors and browser connection failures close the peer and surface errors`. |

`hidden_client_keeps_the_peer_across_daemon_replace` composes the hidden-page
and daemon-link tests. Add an implementation test only when a verifier trace
shows the current client or daemon can close that peer or move its expiry.

## Outside the models

The following stay in the implementation and its existing tests:

- DTLS, certificate generation, fingerprint cryptography, ICE connectivity checks, and TURN allocation.
- SCTP, congestion control, Mux credit, and fair scheduling.
- Admission counts, rate limits, and byte caps, except where `route_fence.qnt` checks that overflow fails one peer and preserves the route.
- Media codecs, capture, and desktop input.
- Catalog synchronization, ACP, Git, and session history.

A transient rate-limit or storage failure is covered by the existing server
tests cited above. It is not a separate model.

## CI class

`spec:test` is part of `ci:preflight`. Its budget for all current modules at
200 samples is 60 seconds. Above that, reduce samples or split a module
before moving the task off preflight. `spec:verify` is not a CI job.

A pull request or `main` push is `specs_only` when every changed path is
either `specs/*.qnt` or already classified as documentation. That class runs
preflight, including `spec:test`, and skips static checks, the platform and
Android and iOS test jobs, backend integration, Build, the Nix server image,
and Linux packages. `Gate` treats those skips like a documentation-only
skip. `scripts/ci-docs-only.test.ts` covers the class.

Any implementation file in the same diff leaves the class. The ordinary
platform and backend detectors then apply, and preflight still runs
`spec:test`. Scheduled and manual runs stay on the full tier and still do
not run `spec:verify`.

`specs/` is not part of the documentation allowlist. `mise.toml` and
`mise.lock` remain packaging paths, so the change that introduces the tool
runs packaging. Later model-only edits do not.

## Delivery

1. Land the toolchain, `spec:test`, `spec:verify`, the `specs_only` class,
   and `specs/grant_lifecycle.qnt` with the runs in the grant table. This
   change updates the environment task table and the CI classifier docs.
2. Complete any grant runs that the first change left as stubs, then run
   `spec:verify` for that module before considering its action set checked.
3. Add `specs/route_fence.qnt` and its verify invocation in one change.
4. Add `specs/mux_streams.qnt` and its verify invocation in one change.
5. Add `specs/link_liveness.qnt` and its verify invocation in one change.

Each step merges on its own. A decision change after that updates the one
module that contains the affected action, that module's named runs, and the
prose that owns the decision.
