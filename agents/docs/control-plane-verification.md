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

A model checks interleavings of grants, signaling, link liveness, recovery
admission, credential close and its cleanup, local claims, offer revocation,
setup error preservation, routing, and Mux stream lifetime. The prose documents
remain the decisions. A model is updated in the same change as the decision it
can violate. A refactor that preserves those
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
| `specs/credential_close.qnt` | 1 daemon socket, 1 peer, 2 credential generations | 6 steps |
| `specs/local_claim.qnt` | 1 claim secret | 6 steps |
| `specs/revocation_cleanup.qnt` | 1 registration, 1 peer set, 1 fault window | 11 steps |
| `specs/offer_revocation.qnt` | 1 grant, 1 offer, 1 daemon route of 4 frames | 9 steps |
| `specs/recovery_admission.qnt` | 1 client, 1 Team/Machine, 2 recovery generations | 10 steps |
| `specs/peer_creation_failure.qnt` | 1 grant, 1 primary failure, independent revoke/notice failures | 4 steps |

Deadlines are actions (`reservation_due`, `authorization_due`, `setup_due`,
`link_dead`), not counters. Changing a duration in the prose leaves the model
unchanged. Changing which event closes, preserves, or replaces a peer updates
the action.

`mise run spec:test` typechecks every `specs/*.qnt`, executes its named
regression runs, and samples interleavings through its `init` and `step`:

```sh
quint typecheck "$spec"
quint test "$spec" --backend typescript --max-samples 200 --seed 1 --match '^(?:<run names>)$'
quint run "$spec" --backend typescript --max-samples 200 --max-steps 20 \
  --seed 1 --verbosity 1 --invariants <all inv_* names>
```

Quint's default test filter executes only definitions whose names end in
`Test`. `scripts/check-specs.ts` selects every `run` in the file instead, so
the witness names below stay free of that suffix. Each model declares its
state predicates as `val inv_*`, with an optional `: bool` annotation. The
script passes every such predicate to the simulator. Named runs assert their
specific witness; sampled runs check every invariant at initialization and
after each transition they visit. Repeating a named run does not explore
different action orderings unless that run itself chooses them.

The task fails when `specs/` contains no model or a model has no named run or
invariant, so missing checks cannot pass silently. A disabled step is written
`action.fail()` and is the last step of its run: Quint does not carry state past
`fail()`. While editing one
scenario, narrow it with
`quint test specs/<file>.qnt --backend typescript --match <run> --max-samples 20 --seed 1`.
The committed task keeps the shared seed and the full sample count. A seed
that exposes a real invariant failure is added as its own named `run`; the
task does not accumulate extra seeds.

The task explicitly selects the TypeScript runner rather than depending on
Quint's backend default. The 200 sampled traces of at most 20 transitions
complement the named regressions; they do not exhaust all interleavings or
replace the symbolic checks below.

`mise run spec:verify` is local. Each module is listed explicitly and passes
its invariants with `--invariants`, so a failure names the predicate:

```sh
quint verify specs/grant_lifecycle.qnt --max-steps 6 --invariants <names>
```

Start at 6 steps. `route_fence`, `mux_streams`, `link_liveness`,
`credential_close`, and `local_claim` finish in seconds. `grant_lifecycle`
takes about 5 minutes. Apalache rejects an inductive
check of its maps because the next-state value is unconstrained. Splitting
the module would drop the interleavings its invariants exist to check, so
the task keeps the 6-step search. Raising the step bound is not the
response to a slow or inconclusive check.

A bound exceeds 6 only when the race a module exists for is longer. The
shortest trace in which the earlier daemon cleanup or offer notice failed is
7 steps, so a 6-step search passes that code. `revocation_cleanup` uses 11
steps, the length of a failed cleanup retried after faults stop and followed by
a successful enrollment; it finishes in seconds. `offer_revocation` uses 9
steps, the length of an early notice repeated after the answer and applied by
the daemon; it takes under a minute. Record such a bound with the trace that
sets it.

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
| `claim_local` | The one-use secret succeeds once, and only for a `local` grant inside the claim window. A second claim, a claim after close, and a claim of a `webrtc` grant fail. A `local` grant cannot submit SDP. The unclaimed window is `specs/local_claim.qnt`. |

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
node has its own lease, routing health, and connection identity. PostgreSQL
holds the current route, the immutable offer and answer, and the bounded early-ICE list. The
daemon queue has a reserved reconciliation slot. One registration is in
scope; another Team's connection is a distinct route and cannot replace this
one.

| Action | Rule |
| --- | --- |
| `replace_route` | The new connection identity becomes the route. |
| `late_message` / `disconnect_cleanup` | An old identity cannot deliver, revoke, or clean up the new route. |
| `lease_lost` | The node's local sockets lose authority. |
| `release_failed` / `renew` | A failed route release marks its holder unhealthy and drops its authority. A later lease renewal leaves that holder fenced; a different healthy node can claim the route. |
| `presence_notify_failed` | A failed presence notification leaves the committed registration in place. |
| `envelope_failed` | A failed or malformed inbox envelope leaves that lease and the current route in place. |
| `await_request` / `expire_request` / `release_gate` | A cross-instance request keeps the expiry it arrived with while it waits for the registration gate. Expiry retires it. Opening the gate afterwards leaves it out of the daemon queue. |
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
- Route authority requires the current holder's live lease and healthy routing. An unhealthy holder stays fenced across renewal and replacement by another healthy node.
- A retired cross-instance request is absent from the daemon queue.

Named runs: `stale_identity_cannot_fence_the_new_route`,
`snapshot_before_grant_cannot_close_it`, `missed_revocation_closes_on_reconcile`,
`coalesce_keeps_snapshot_position`, `early_ice_cannot_block_the_answer`,
`overflow_fails_the_peer_only`, `lost_negotiation_opens_a_new_peer`,
`failed_envelope_keeps_authority`, `expired_request_is_not_enqueued`,
`release_failure_stays_offline_across_renewal`,
`release_failure_allows_healthy_node_replacement`, and
`presence_failure_keeps_the_registration`.

| Run | Implementation evidence already present |
| --- | --- |
| `snapshot_before_grant_cannot_close_it` | `apps/server/src/hub/reconcile_tests.rs` `postgres_reconciliation_repairs_missed_revocation_and_precedes_new_offers`. |
| `coalesce_keeps_snapshot_position` | `apps/server/src/hub/outbox_tests.rs` `reconciliation_uses_reserved_capacity_and_follows_intervening_offers` and `repeated_reconciliation_cannot_move_a_snapshot_behind_new_requests`. |
| `overflow_fails_the_peer_only` | `apps/server/src/hub.rs` `saturated_revocation_requests_reconciliation_and_preserves_machine_presence`. `apps/server/src/websocket.rs` covers transient storage failure and an interrupted handshake, which must not revoke an existing peer. |
| `failed_envelope_keeps_authority` | `apps/server/src/hub/cluster_tests.rs` `postgres_bad_envelope_isolated_without_losing_the_following_disconnect`. `postgres_database_failure_still_fences_existing_sockets` and `postgres_expired_lease_fences_before_waiting_for_the_registration_gate` are the database and lease failures that still remove authority. |
| `expired_request_is_not_enqueued` | `apps/server/src/hub/cluster_tests.rs` `an_expired_request_is_not_queued_when_its_gate_and_timer_are_both_ready` and `postgres_request_expiry_cancels_gated_enqueue_without_taking_machine_offline`. |
| `release_failure_stays_offline_across_renewal`, `release_failure_allows_healthy_node_replacement` | `apps/server/src/hub.rs` `remove_daemon` marks its node's realtime routing unhealthy when `release_machine_route` fails, and `apps/server/src/hub/cluster.rs` `renew` refuses a node that is not ready. `Hub::add_daemon` checks the receiving node's independent health before claiming the route. |
| `presence_failure_keeps_the_registration` | `apps/server/src/websocket.rs` keeps a committed daemon registration when the presence notification fails. |

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

Viewer invalidation overflow, a full daemon queue, and a stalled critical
delivery each affect one client socket. This module does not vary them.
`route_fence.qnt` checks peer-event overflow separately. `apps/server/src/hub.rs`
`distinct_hint_overflow_reconnects_only_its_viewer_and_keeps_daemon_rpc_live`
reconnects only that viewer and leaves the daemon route current with an empty
queue. `saturated_request_reports_busy_without_taking_machine_offline` returns
`machine_busy`, keeps that route, and leaves the original command as the only
queued message. `apps/server/src/hub/cluster_tests.rs`
`postgres_stalled_critical_delivery_closes_its_client_without_fencing_the_node`
closes the stalled client with 1012 and leaves the other client and the node's
lease in place.

| Action | Rule |
| --- | --- |
| `hide_page` | Heartbeats stop. The client identity and the peer stay. |
| `show_page` / `probe_ok` / `probe_miss` | A fresh resume probes the open socket. An answer keeps it. A miss declares that client link dead. |
| `resume_idle` | A hidden socket already past the idle deadline is declared dead without a probe. |
| `link_dead` | A visible client socket is declared dead. A hidden socket does not take this action. |
| `daemon_link_dead` | The daemon reports the control link down. The client socket and the peer stay. |
| `begin_client_close` / `begin_daemon_close` / `abandon_client_close` / `abandon_daemon_close` | An orderly close reports the socket down immediately. The handshake stall abandons that socket, and only then may its identity be replaced. |
| `replace_client_socket` | The next client identity replaces a dead client socket. Only this action writes that identity. The daemon route, the peer, and expiry stay. |
| `replace_daemon_route` | The next daemon identity replaces a dead control link and fences the previous identity. Only this action writes that identity. Expiry stays. |
| `late_client` / `late_daemon` | A message carrying the replaced identity leaves the new route, the other socket, and the peer unchanged. |
| `disconnected_grace` / `recover` / `recovery_due` | A transient disconnect can recover. The recovery deadline closes the peer. |
| `failed_immediate` | `failed` and `closed` close the peer immediately, including during the grace window. Signaling identities stay. |

Invariants:

- The client route is one of the three identity shapes `(c1, none, 0)`, `(c2, c1, 1)`, and `(c1, c2, 2)`. The daemon route is the same shape on `d1` and `d2`.
- The client phase is `up`, `hidden`, `probing`, `closing`, or `dead`. The daemon phase is `up`, `closing`, or `dead`. A `closing` socket keeps its identity.
- A closed peer records `failed` or `recovery`. An established or grace peer has an empty close cause.
- Expiry stays at the value written for the established peer.

Named runs: `hidden_page_skips_link_dead`, `fresh_resume_probes_before_replace`,
`probe_ok_keeps_the_socket`, `probe_miss_replaces_only_the_client`,
`resume_idle_replaces_the_client_only`, `both_links_down_keep_the_established_peer`,
`daemon_replace_fences_the_old_identity`,
`hidden_client_keeps_the_peer_across_daemon_replace`,
`grace_recovers_without_closing`, `recovery_due_closes_the_peer`,
`failed_closes_the_peer`, `closing_daemon_reports_down_before_replace`, and
`closing_socket_cannot_be_replaced`.

| Run | Implementation evidence already present |
| --- | --- |
| `hidden_page_skips_link_dead`, `fresh_resume_probes_before_replace`, `probe_ok_keeps_the_socket`, `probe_miss_replaces_only_the_client`, `resume_idle_replaces_the_client_only` | `packages/client/src/http-central.test.ts` skips liveness traffic while hidden, probes a resumed socket, keeps a socket that answers, replaces a socket that misses the probe, and replaces an idle suspended socket on return. A native foreground event takes that same resume path when the page never becomes hidden. |
| `both_links_down_keep_the_established_peer` | `packages/client/src/remote.test.ts` preserves peers during signaling loss. `packages/client/src/http-central.test.ts` reports signaling loss without a peer revocation. `apps/daemon/src/central-client.test.ts` `a silent control link is abandoned after a bounded grace and replaced` reports the daemon disconnected before the replacement socket exists. |
| `closing_daemon_reports_down_before_replace`, `closing_socket_cannot_be_replaced` | The daemon test above sets `connected` false when the close begins, then replaces the socket only after the close grace. `packages/client/src/http-central.ts` does the same for the client signaling socket. |
| `daemon_replace_fences_the_old_identity` | The daemon test above replaces the control link. Fencing a late frame on the retired identity remains a model run until a trace shows that frame changing the new route. |
| `grace_recovers_without_closing`, `recovery_due_closes_the_peer` | `packages/client/src/peer-lifecycle.test.ts` `a recovered disconnected state never fails the peer`. `packages/components/src/composables/useDesktopConnection.test.ts` `a transient disconnected state does not tear down a recoverable desktop peer`. |
| `failed_closes_the_peer` | `packages/components/src/composables/useDesktopConnection.test.ts` `native errors and browser connection failures close the peer and surface errors`. |

`hidden_client_keeps_the_peer_across_daemon_replace` composes the hidden-page
and daemon-link tests. Add an implementation test only when a verifier trace
shows the current client or daemon can close that peer or move its expiry.

## Credential close

`specs/credential_close.qnt` is one daemon control socket, one machine
identity, and two credential generations. It starts in `hello`, before the
peer exists. `generation` stops at 1 so the re-enrollment stays finite; that
bound is not a product limit. `retryable_close` and `reconnect` are this
module's `signaling_down` / `signaling_up`. `hello_blip` is the pre-auth form
of that pair. `late_rejection` is `late_message` for the retired token.
Reservation, inbox, and lease loss stay in the grant and route modules.

A close during `hello` with code 1012 reconnects the same machine identity and
does not record a logout. An invalid authenticate frame uses 4401, records the
logout, and keeps that machine identity; re-enrollment does not open the
closed hello as a live peer. After `hello_ready`, a close code of 1012, a
transport drop, or a link declared dead reconnects with the same credential
and leaves the peer open. Close codes 4401 and 4403 retire that credential,
close the registration's peers, and do not schedule that reconnect.
Re-enrollment replaces the token. A rejection that belonged to the retired
token leaves the new credential in place. Accepted work stays set. Expiry
stays at the value written for the established peer.

| Action | Rule |
| --- | --- |
| `hello_blip` / `reconnect` | A pre-auth transport close is retryable. The machine identity stays, and no peer is opened. |
| `hello_reject` | An invalid authenticate frame records logout and keeps the machine identity. Reconnect stays disabled until re-enrollment. |
| `hello_ready` | A completed hello opens the peer. A rejected hello cannot take this step. |
| `retryable_close` / `reconnect` | The same credential returns. The peer and its expiry stay. |
| `credential_rejected` | The current credential is retired and the peer closes. Reconnect is disabled. |
| `reenroll` | A revoked registration receives the next credential. The closed peer stays closed. |
| `late_rejection` | A rejection of the retired token does not revoke the re-enrolled credential. |
| `rejected_credential_stays` | Once that re-enrollment is itself rejected, the credential stays revoked. |
| `accept_work` | Credential rejection leaves the accepted-work boolean set. |

Invariants:

- Expiry stays at the value written for the established peer.
- The accepted-work boolean stays set once work is accepted.
- A closed peer records `credential`. An established peer has an empty close cause.
- A revoked credential has a down link and a closed peer.
- Generation 1 is reached only after that peer has closed for credential rejection.
- The generation is 0 or 1, the link is `up` or `down`, and admission is `hello` or `ready`.
- The machine identity stays `m1`. An established peer has already left `hello`.

Named runs: `hello_blip_reconnects_the_same_machine`,
`hello_reject_keeps_the_machine_identity`,
`hello_reject_reenrolls_the_same_machine`, `retryable_close_keeps_the_peer`,
`credential_rejection_closes_peers_without_reconnect`, and
`late_rejection_keeps_the_reenrolled_credential`.

| Run | Implementation evidence already present |
| --- | --- |
| `hello_blip_reconnects_the_same_machine`, `hello_reject_keeps_the_machine_identity`, `hello_reject_reenrolls_the_same_machine` | `apps/server/src/websocket.rs` `pre_auth_close` uses 1012 for an interrupted hello and 4401 for an invalid authenticate frame. `apps/daemon/src/central-client.test.ts` `network drop mid-hello reconnects with the same machine credentials instead of revoking`. `apps/daemon/src/central-client.ts` `enroll` retains the Team machine identity. |
| `retryable_close_keeps_the_peer` | `apps/daemon/src/central-client.test.ts` `network drop mid-hello reconnects with the same machine credentials instead of revoking`. |
| `credential_rejection_closes_peers_without_reconnect` | `apps/daemon/src/central-client.test.ts` `explicit credential rejection persists logout without treating transport loss as revocation`. `#revoked` closes the registration's peers and retains execution. |
| `late_rejection_keeps_the_reenrolled_credential` | `apps/daemon/src/central-client.test.ts` `a late rejection of a retired token cannot revoke a re-enrolled Team`. |

## Local claim

`specs/local_claim.qnt` is one claim secret from `prepareLocal`. The 30-second
window and the grant expiry are actions, `claim_due` and `authorization_due`.
The secret is recorded when the local grant is prepared. Inbox retention of
that secret stays in the authorization prose. This module keeps one secret.
A prepare after that secret's grant expiry is a new grant and is not an
action here.

An unclaimed window or the grant expiry closes a prepared peer and leaves the
secret spent. Opening the claim, then closing the socket or reaching grant
expiry, also leaves it spent. A second open and another prepare of the same
secret fail. A WebRTC grant is rejected before a secret is recorded.

| Action | Rule |
| --- | --- |
| `issue_local` | Preparing a local grant records the secret and opens the claim window. |
| `issue_webrtc` | A WebRTC grant records nothing and cannot be opened as a local claim. |
| `open_local` | The secret succeeds once, from the prepared phase. |
| `claim_due` | The unclaimed window closes the peer. The secret stays spent. |
| `authorization_due` | Grant expiry closes a prepared or claimed peer. The secret stays spent. |
| `close_claimed` | Closing the claimed socket does not make the secret reusable. |
| `spent_secret_stays` | A sealed secret, or a WebRTC grant that was never recorded, stays unchanged. |

Invariants:

- A local grant has its secret spent. A WebRTC grant is absent, unspent, and unsealed.
- Prepared and claimed phases are local, spent, and unsealed.
- A sealed claim is closed and spent.
- The blank claim is absent, unspent, and unsealed.

Named runs: `unclaimed_window_spends_the_secret`,
`unclaimed_window_rejects_another_prepare`, `second_open_fails`,
`claimed_close_spends_the_secret`, `authorization_due_spends_the_secret`, and
`webrtc_grant_cannot_be_claimed`.

| Run | Implementation evidence already present |
| --- | --- |
| `unclaimed_window_spends_the_secret`, `unclaimed_window_rejects_another_prepare` | `apps/daemon/src/authorized-peers.test.ts` `an unclaimed local secret expires after 30 seconds without extending its grant`. |
| `second_open_fails`, `claimed_close_spends_the_secret` | `apps/daemon/src/authorized-peers.test.ts` `unclaimed local peers are capped and a closed claim retains replay protection`. `apps/daemon/src/local-channel.test.ts` rejects a second `localOpen` of a live claim. |
| `authorization_due_spends_the_secret` | The closed-claim test above retains replay protection through close. Grant expiry uses the same `#used` entry, which is removed only when that expiry has passed. |
| `webrtc_grant_cannot_be_claimed` | `apps/daemon/src/authorized-peers.test.ts` rejects `prepareLocal` unless the grant transport is `local`. |

## Revocation cleanup

`specs/revocation_cleanup.qnt` is the daemon side of `credential_rejected` in
`credential_close.qnt`: one registration, its peers as one set, and the
re-enrollment that waits for their cleanup. `rejected` starts one cleanup
memo; a later rejection returns that same memo and is not a separate action.
The cleanup closes the peers and persists the revoked credential. Faults can
fail either step until `heal`, which is permanent. An attempt records whether
it started after `heal`.

The memo settles only after both steps finish, and resolves only if both
succeeded. Each close removes its peer before awaiting resources, so a failed
close still empties the set. Re-enrollment awaits the memo. A rejected memo
is replaced by a new cleanup once in that attempt. If the new cleanup also
fails, only that attempt fails; the next attempt retries again. A resolved
memo lets the attempt verify and save the new token, which clears the memo.

| Action | Rule |
| --- | --- |
| `rejected` | A rejection of the current credential revokes it and starts the cleanup. |
| `close_ok` / `close_fails` | Closing empties the peer set either way. Only an open peer can fail to close, and only before `heal`. |
| `save_ok` / `save_fails` | Persisting the revoked credential can fail only before `heal`. |
| `settle` | The memo waits for both steps, then resolves or rejects. |
| `heal` | Faults stop for the rest of the trace. |
| `enroll_start` | An attempt starts on a revoked credential and waits on the memo. |
| `enroll_retry` | A rejected memo is replaced by a new cleanup, once per attempt. |
| `enroll_gives_up` | The retried cleanup failed. Only this attempt fails. |
| `enroll_fails` / `enroll_succeeds` | After a resolved memo, verification can fail only before `heal`. Success activates the new credential and clears the memo. |
| `open_peer` | An active registration opens peers again. |

Invariants:

- An attempt that starts after `heal` does not fail.
- A settled memo has both steps finished, so a retry never overlaps an earlier credential write.
- A resolved memo has both steps succeeded and no open peer.
- An active credential has no cleanup. A revoked credential has a started cleanup.
- A finished close leaves no open peer.
- A running attempt has a revoked credential. Otherwise the attempt record is blank.
- Every field stays within its named values.

Named runs: `failed_cleanup_is_retried_by_reenrollment`,
`reenrollment_waits_for_pending_cleanup`, `cleanup_settles_after_both_steps`,
`faulty_retry_fails_only_that_attempt`, and
`reenrolled_registration_opens_peers`.

| Run | Implementation evidence already present |
| --- | --- |
| `failed_cleanup_is_retried_by_reenrollment`, `faulty_retry_fails_only_that_attempt` | `apps/daemon/src/central-client.test.ts` `a failed revocation cleanup does not block re-enrollment after the fault clears`. |
| `cleanup_settles_after_both_steps` | `apps/daemon/src/central-client.ts` `#retire` waits for both steps with `Promise.allSettled`. |
| `reenrollment_waits_for_pending_cleanup`, `reenrolled_registration_opens_peers` | `apps/daemon/src/central-client.test.ts` `a late rejection of a retired token cannot revoke a re-enrolled Team`. |

## Offer revocation

`specs/offer_revocation.qnt` is one WebRTC offer, its grant, and the
daemon route that receives both. The route is first-in, first-out, holding
four frames. An offer passes the registration gate, so it is ordered after
earlier snapshots. A revocation notice bypasses that gate and can reach the
route before an offer that was checked earlier. The daemon checks expiry, not
revocation, and closing a peer it never created does nothing. `access_ends`
is a login or Team access change that leaves the grant row valid.

A notice can therefore arrive first and close nothing. The offer then
creates a live daemon peer. Committing the answer locks only an unrevoked
grant, and the final check needs the login, access, and grant. Each failure
revokes the grant again and queues a new notice. An offer abandoned for any
other reason also revokes and notifies.

| Action | Rule |
| --- | --- |
| `offer_check` | The first check needs a valid grant and access. A failure sends no offer. |
| `offer_send` | The offer joins the route through the registration gate. |
| `revoke` / `notice_queued` | Revocation commits and publishes one notice. The notice joins the route outside the gate. |
| `access_ends` | Login or access ends without revoking the grant row. |
| `heartbeat` | A snapshot lists the grant only while it is valid. |
| `daemon_receive` | The daemon applies the head frame. An offer creates the peer; a notice or a snapshot without the grant closes it. |
| `offer_commit` | The answer commits only for a valid grant. A revoked grant fails and notifies again. |
| `offer_recheck` | The final check fails on a withdrawn login, access, or grant, then revokes and notifies. |
| `offer_abandoned` | A timeout, daemon error, or lost route revokes and notifies. |

Invariants:

- Once no frame, notice, or setup step is pending, a revoked grant has no live daemon peer.
- Once nothing is pending, a failed setup has no live daemon peer.
- A failed setup has a revoked grant. A closed daemon peer has a revoked grant.
- The offer is sent at most once, and only from a request that passed its first check.
- A committed or answered offer has reached the daemon.
- The route holds at most four known frames.

Named runs: `early_notice_is_repeated_after_the_answer`,
`ended_access_revokes_the_answered_grant`,
`abandoned_offer_closes_the_late_daemon_peer`,
`revoked_grant_sends_no_offer`, and `answered_offer_keeps_the_daemon_peer`.

| Run | Implementation evidence already present |
| --- | --- |
| `early_notice_is_repeated_after_the_answer` | `apps/server/src/peers/shared_tests.rs` `offer_revoked_during_delivery_notifies_the_daemon_after_it_answers` revokes the grant while the daemon holds the offer and expects a second `PeerRevoked`. |
| `ended_access_revokes_the_answered_grant` | The same test ends the login while the daemon holds the offer. `apps/server/src/peers/local_tests.rs` `local_grants_revoke_when_daemon_rejects_or_login_is_revoked_during_delivery` covers the local claim. |
| `abandoned_offer_closes_the_late_daemon_peer` | `apps/server/src/peers/signaling.rs` `negotiate` revokes and notifies after a timeout or daemon error. |
| `revoked_grant_sends_no_offer` | `apps/server/src/peers/signaling.rs` `offer` runs `authorize_webrtc` before it stores or sends the offer. `closing_shared_peer_during_offer_prevents_answer_and_ice_publication` covers a close that lands while the daemon holds the offer. |
| `answered_offer_keeps_the_daemon_peer` | `apps/server/src/peers/shared_tests.rs` `shared_offer_candidates_and_daemon_ice_cross_instances`. |

## Recovery admission

`specs/recovery_admission.qnt` connects signaling recovery to admission of new
machine work. `link_liveness.qnt` checks socket replacement and existing peer
lifetime; it does not track whether a cached machine roster can authorize a
new request. This model adds a recovery generation, the generation and online
state of a roster read, and the moment a machine RPC or peer creation is sent.
Native foreground and Electron power resume use the same `resume` action.

The old behavior has a two-transition counterexample: `resume` enters probing
while the cached machine remains online; `dispatch` sends a request using that
old roster. `inv_current_roster_before_dispatch` fails. The corrected dispatch
requires both a ready signaling connection and a roster from the current
generation. A pong alone cannot certify the machine roster. Late reads, failed
reads, a second resume, and disposal are separate transitions. The invariant
records whether an unsafe dispatch ever occurred, so a later successful read
cannot hide the violation.

The named runs cover blocking during a probe, fresh online/offline rosters,
discarding late reads, retrying a failed read without replaying a write, disposal,
and preserving existing peers and accepted work. The 10-step symbolic bound
includes two recoveries, a new offline roster, the old online read arriving
after it, and attempted dispatch.
`packages/client/src/http-central-recovery.test.ts` exercises these schedules
against the real HTTP client with controlled sockets and fetch completion.
Handler tests distinguish initial `pageshow` from a persisted back/forward-cache
restore: only the latter maps to the model's `resume` action.
The tests also resume during CSRF acquisition and HTTP library preparation, checking
admission at the host fetch rather than only before asynchronous preparation.
`apps/desktop/src/main/central-account.test.ts` checks the main-process resume
and focus hooks and their cleanup.

The model intentionally covers one Team/Machine. Implementation tests cover
separate Teams and account replacement. Initial API-only clients and already
authorized peer traffic retain their existing behavior. An online snapshot
does not promise that the daemon stays online after the read, and the model
does not assert that every HTTP 503 is preventable.

## Peer setup error preservation

`specs/peer_creation_failure.qnt` starts after a grant has been reserved and
the initial online check has passed. Setup failure, durable revocation, and
notification are independent actions. The primary error and returned error
are explicit state; resource cleanup alone cannot establish correct HTTP
behavior.

The old behavior has two counterexamples:

- `setup_fails` then `revoke_fails` returns the storage error instead of the
  original failure (2 transitions).
- `router_fails`, `setup_fails`, `revoke_ok`, then `notify_fails` returns
  `machine_offline` instead of the original failure despite committed
  revocation (4 transitions).

Both violate `inv_primary_error_preserved`. The fixed model keeps cleanup
failure separate from the response. Its other invariants require notification
to follow revocation, retain committed revocation after a failed notice, and
avoid claiming cleanup succeeded when it did not. The 4-step bound includes
both minimal counterexamples. Five named runs cover revocation failure,
notification failure after TURN/local/offer failure, withdrawn authorization,
and successful cleanup.

`apps/server/src/peers/creation_failure_tests.rs` injects failures into an
isolated PostgreSQL test schema and calls the actual handlers. The five
regressions assert the original HTTP status, code, message, and relevant reason,
as well as the persisted revocation state. They fail on the old implementation
and pass with cleanup errors logged separately. These traces prove reachable
code defects; they do not identify the cause of a particular production event
without its corresponding server evidence.

## Outside the models

The following stay in the implementation and its existing tests:

- DTLS, certificate generation, fingerprint cryptography, ICE connectivity checks, and TURN allocation.
- SCTP, congestion control, Mux credit, and fair scheduling.
- Admission counts, rate limits, and byte caps, except where `route_fence.qnt` checks that overflow fails one peer and preserves the route.
- Media codecs, capture, and desktop input.
- Catalog synchronization, ACP, Git, and session history.

Rate-limit policy and storage implementation remain in server tests. A storage
failure is an abstract transition where its ordering affects cleanup or the
error returned to a caller.

## CI class

`spec:test` is part of `ci:preflight`. Its budget for all current modules,
including named runs and 200 sampled traces per model, is 60 seconds. Above
that, reduce samples or split a module before moving the task off preflight.
`spec:verify` is not a CI job.

A pull request or `main` push is `specs_only` when every changed path is
either `specs/*.qnt` or already classified as documentation outside `docs/`.
Website edits retain their static build and deployment. That class runs
preflight, including `spec:test`, and skips static checks, the platform and
Android and iOS test jobs, backend integration, Build, the Nix server image,
and Linux packages. Website deployment also skips the class because it produces
no website artifact. `Gate` treats those skips like a documentation-only
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
6. Add `specs/credential_close.qnt` and `specs/local_claim.qnt` with their verify invocations.
7. Add `specs/revocation_cleanup.qnt` and `specs/offer_revocation.qnt` with
   their verify invocations, the daemon cleanup retry, and the repeated offer
   notice.

Each step merges on its own. A decision change after that updates the one
module that contains the affected action, that module's named runs, and the
prose that owns the decision.
