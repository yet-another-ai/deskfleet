// Client and daemon signaling liveness for one established peer.
// Link decisions live in agents/docs/architecture.md. Peer disconnect and
// failure live in agents/docs/webrtc-security.md. This module checks their
// interleavings; agents/docs/control-plane-verification.md owns the runs below.
module link_liveness {
  // Two identities per socket. generation stops at 2 so the route stays finite.
  pure def other_client(id: str): str = if (id == "c1") "c2" else "c1"
  pure def other_daemon(id: str): str = if (id == "d1") "d2" else "d1"

  type Socket = {
    phase: str,
    identity: str,
    previous: str,
    generation: int,
  }

  type Peer = {
    phase: str,
    closed_by: str,
    expiry: int,
  }

  var client: Socket
  var daemon: Socket
  var peer: Peer

  action init: bool = all {
    client' = { phase: "up", identity: "c1", previous: "", generation: 0 },
    daemon' = { phase: "up", identity: "d1", previous: "", generation: 0 },
    peer' = { phase: "established", closed_by: "", expiry: 1 },
  }

  /// Hidden pages skip heartbeats. This does not replace the socket or close the peer.
  action hide_page: bool = all {
    client.phase == "up",
    client' = client.with("phase", "hidden"),
    daemon' = daemon,
    peer' = peer,
  }

  /// A resume inside the idle deadline probes the open socket before replacing it.
  action show_page: bool = all {
    client.phase == "hidden",
    client' = client.with("phase", "probing"),
    daemon' = daemon,
    peer' = peer,
  }

  action probe_ok: bool = all {
    client.phase == "probing",
    client' = client.with("phase", "up"),
    daemon' = daemon,
    peer' = peer,
  }

  action probe_miss: bool = all {
    client.phase == "probing",
    client' = client.with("phase", "dead"),
    daemon' = daemon,
    peer' = peer,
  }

  /// The idle deadline already passed while hidden, so resume declares the link dead.
  action resume_idle: bool = all {
    client.phase == "hidden",
    client' = client.with("phase", "dead"),
    daemon' = daemon,
    peer' = peer,
  }

  /// Visible idle only. A hidden heartbeat gap does not take this action.
  action link_dead: bool = all {
    client.phase == "up",
    client' = client.with("phase", "dead"),
    daemon' = daemon,
    peer' = peer,
  }

  action daemon_link_dead: bool = all {
    daemon.phase == "up",
    daemon' = daemon.with("phase", "dead"),
    client' = client,
    peer' = peer,
  }

  /// The close handshake has no deadline. Disconnect is reported before the socket is replaced.
  action begin_client_close: bool = all {
    client.phase == "up",
    client' = client.with("phase", "closing"),
    daemon' = daemon,
    peer' = peer,
  }

  action begin_daemon_close: bool = all {
    daemon.phase == "up",
    daemon' = daemon.with("phase", "closing"),
    client' = client,
    peer' = peer,
  }

  action abandon_client_close: bool = all {
    client.phase == "closing",
    client' = client.with("phase", "dead"),
    daemon' = daemon,
    peer' = peer,
  }

  action abandon_daemon_close: bool = all {
    daemon.phase == "closing",
    daemon' = daemon.with("phase", "dead"),
    client' = client,
    peer' = peer,
  }

  /// Only this action writes the client identity. The daemon route and the peer stay.
  action replace_client_socket: bool = all {
    client.phase == "dead",
    client.generation < 2,
    client' = {
      phase: "up",
      identity: other_client(client.identity),
      previous: client.identity,
      generation: client.generation + 1,
    },
    daemon' = daemon,
    peer' = peer,
  }

  /// Only this action writes the daemon identity. Expiry stays on the peer record.
  action replace_daemon_route: bool = all {
    daemon.phase == "dead",
    daemon.generation < 2,
    daemon' = {
      phase: "up",
      identity: other_daemon(daemon.identity),
      previous: daemon.identity,
      generation: daemon.generation + 1,
    },
    client' = client,
    peer' = peer,
  }

  action late_client: bool = all {
    client.previous != "",
    client' = client,
    daemon' = daemon,
    peer' = peer,
  }

  action late_daemon: bool = all {
    daemon.previous != "",
    client' = client,
    daemon' = daemon,
    peer' = peer,
  }

  action disconnected_grace: bool = all {
    peer.phase == "established",
    peer' = peer.with("phase", "grace"),
    client' = client,
    daemon' = daemon,
  }

  action recover: bool = all {
    peer.phase == "grace",
    peer' = peer.with("phase", "established"),
    client' = client,
    daemon' = daemon,
  }

  action recovery_due: bool = all {
    peer.phase == "grace",
    peer' = peer.with("phase", "closed").with("closed_by", "recovery"),
    client' = client,
    daemon' = daemon,
  }

  action failed_immediate: bool = all {
    peer.phase == "established" or peer.phase == "grace",
    peer' = peer.with("phase", "closed").with("closed_by", "failed"),
    client' = client,
    daemon' = daemon,
  }

  action step: bool = any {
    hide_page,
    show_page,
    probe_ok,
    probe_miss,
    resume_idle,
    link_dead,
    daemon_link_dead,
    begin_client_close,
    begin_daemon_close,
    abandon_client_close,
    abandon_daemon_close,
    replace_client_socket,
    replace_daemon_route,
    late_client,
    late_daemon,
    disconnected_grace,
    recover,
    recovery_due,
    failed_immediate,
  }

  val inv_client_identity: bool =
    (client.generation == 0 and client.identity == "c1" and client.previous == "") or
    (client.generation == 1 and client.identity == "c2" and client.previous == "c1") or
    (client.generation == 2 and client.identity == "c1" and client.previous == "c2")

  val inv_daemon_identity: bool =
    (daemon.generation == 0 and daemon.identity == "d1" and daemon.previous == "") or
    (daemon.generation == 1 and daemon.identity == "d2" and daemon.previous == "d1") or
    (daemon.generation == 2 and daemon.identity == "d1" and daemon.previous == "d2")

  val inv_link_phases: bool =
    (client.phase == "up" or client.phase == "hidden" or client.phase == "probing" or client.phase == "closing" or client.phase == "dead") and
    (daemon.phase == "up" or daemon.phase == "closing" or daemon.phase == "dead")

  val inv_peer_close: bool =
    if (peer.phase == "closed") peer.closed_by == "failed" or peer.closed_by == "recovery"
    else if (peer.phase == "established" or peer.phase == "grace") peer.closed_by == ""
    else false

  val inv_expiry_fixed: bool = peer.expiry == 1

  run hidden_page_skips_link_dead = {
    init
      .then(hide_page)
      .expect(
        client.phase == "hidden" and client.identity == "c1" and client.generation == 0 and
        daemon.phase == "up" and peer.phase == "established" and peer.expiry == 1)
      .then(link_dead.fail())
  }

  run fresh_resume_probes_before_replace = {
    init
      .then(hide_page)
      .then(show_page)
      .expect(
        client.phase == "probing" and client.identity == "c1" and client.previous == "" and
        daemon.identity == "d1" and peer.phase == "established" and peer.expiry == 1)
      .then(replace_client_socket.fail())
  }

  run probe_ok_keeps_the_socket = {
    init
      .then(hide_page)
      .then(show_page)
      .then(probe_ok)
      .expect(
        client.phase == "up" and client.identity == "c1" and client.generation == 0 and
        daemon.identity == "d1" and peer.phase == "established" and peer.expiry == 1)
  }

  run probe_miss_replaces_only_the_client = {
    init
      .then(hide_page)
      .then(show_page)
      .then(probe_miss)
      .expect(client.phase == "dead" and client.identity == "c1" and peer.phase == "established")
      .then(replace_client_socket)
      .expect(
        client.phase == "up" and client.identity == "c2" and client.previous == "c1" and client.generation == 1 and
        daemon.identity == "d1" and daemon.phase == "up" and peer.phase == "established" and peer.expiry == 1)
  }

  run resume_idle_replaces_the_client_only = {
    init
      .then(hide_page)
      .then(resume_idle)
      .expect(client.phase == "dead" and client.identity == "c1" and peer.phase == "established" and peer.expiry == 1)
      .then(replace_client_socket)
      .expect(
        client.identity == "c2" and client.previous == "c1" and daemon.identity == "d1" and
        daemon.phase == "up" and peer.phase == "established" and peer.expiry == 1)
  }

  run both_links_down_keep_the_established_peer = {
    init
      .then(link_dead)
      .then(daemon_link_dead)
      .expect(
        client.phase == "dead" and client.identity == "c1" and daemon.phase == "dead" and daemon.identity == "d1" and
        peer.phase == "established" and peer.closed_by == "" and peer.expiry == 1)
  }

  run daemon_replace_fences_the_old_identity = {
    init
      .then(daemon_link_dead)
      .then(replace_daemon_route)
      .then(late_daemon)
      .expect(
        daemon.phase == "up" and daemon.identity == "d2" and daemon.previous == "d1" and daemon.generation == 1 and
        client.identity == "c1" and client.phase == "up" and peer.phase == "established" and peer.expiry == 1)
  }

  run hidden_client_keeps_the_peer_across_daemon_replace = {
    init
      .then(hide_page)
      .then(daemon_link_dead)
      .then(replace_daemon_route)
      .then(late_daemon)
      .expect(
        client.phase == "hidden" and client.identity == "c1" and client.generation == 0 and
        daemon.identity == "d2" and daemon.previous == "d1" and
        peer.phase == "established" and peer.expiry == 1)
  }

  run grace_recovers_without_closing = {
    init
      .then(disconnected_grace)
      .then(link_dead)
      .expect(peer.phase == "grace" and peer.closed_by == "" and client.phase == "dead" and peer.expiry == 1)
      .then(recover)
      .expect(peer.phase == "established" and peer.closed_by == "" and client.phase == "dead" and peer.expiry == 1)
  }

  run recovery_due_closes_the_peer = {
    init
      .then(disconnected_grace)
      .then(recovery_due)
      .expect(
        peer.phase == "closed" and peer.closed_by == "recovery" and peer.expiry == 1 and
        client.phase == "up" and client.identity == "c1" and daemon.phase == "up" and daemon.identity == "d1")
  }

  run closing_daemon_reports_down_before_replace = {
    init
      .then(begin_daemon_close)
      .expect(
        daemon.phase == "closing" and daemon.identity == "d1" and daemon.generation == 0 and
        client.phase == "up" and client.identity == "c1" and
        peer.phase == "established" and peer.expiry == 1)
      .then(abandon_daemon_close)
      .expect(daemon.phase == "dead" and daemon.identity == "d1" and peer.phase == "established")
      .then(replace_daemon_route)
      .expect(
        daemon.phase == "up" and daemon.identity == "d2" and daemon.previous == "d1" and
        peer.phase == "established" and peer.expiry == 1)
  }

  run closing_socket_cannot_be_replaced = {
    init
      .then(begin_daemon_close)
      .then(begin_client_close)
      .expect(
        daemon.phase == "closing" and client.phase == "closing" and
        daemon.identity == "d1" and client.identity == "c1" and peer.phase == "established")
      .then(replace_daemon_route.fail())
  }

  run failed_closes_the_peer = {
    init
      .then(failed_immediate)
      .expect(
        peer.phase == "closed" and peer.closed_by == "failed" and peer.expiry == 1 and
        client.phase == "up" and client.identity == "c1" and daemon.phase == "up" and daemon.identity == "d1")
  }
}
