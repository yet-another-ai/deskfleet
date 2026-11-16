// Multi-instance control connection for two API nodes, one registration, and two peers.
// Decisions live in agents/docs/architecture.md. This module checks their
// interleavings; agents/docs/control-plane-verification.md owns the runs below.
module route_fence {
  pure val peer_ids = Set("p1", "p2")
  pure val conn_ids = Set("c1", "c2")
  pure val node_ids = Set("n1", "n2")

  type Peer = {
    phase: str,
    revoked: bool,
    expired: bool,
    offer: str,
    latched_offer: str,
    offer_latched: bool,
    gen: int,
    closed_by: str,
    seen_when_closed: bool,
    snap_cause: bool,
  }

  type Route = {
    identity: str,
    holder: str,
    previous: str,
    authority: bool,
    link: bool,
    routed: bool,
  }

  /// At most one snapshot shares the command queue. It keeps the index it was appended at.
  type Queue = {
    len: int,
    a: str,
    b: str,
    c: str,
    snap_pos: int,
    coalesce: bool,
  }

  type Capture = {
    seen_p1: bool,
    seen_p2: bool,
    rev_p1: bool,
    rev_p2: bool,
    exp_p1: bool,
    exp_p2: bool,
    gen: int,
  }

  type Side = {
    epoch: int,
    ice: int,
    answer: bool,
    inbox_lost: bool,
  }

  var route: Route
  var lease: str -> bool
  var peer: str -> Peer
  var queue: Queue
  var capture: Capture
  var side: Side

  pure val blank: Peer = {
    phase: "absent",
    revoked: false,
    expired: false,
    offer: "",
    latched_offer: "",
    offer_latched: false,
    gen: 0,
    closed_by: "",
    seen_when_closed: false,
    snap_cause: false,
  }

  pure val empty_queue: Queue = { len: 0, a: "", b: "", c: "", snap_pos: -1, coalesce: false }

  pure val no_capture: Capture = {
    seen_p1: false,
    seen_p2: false,
    rev_p1: false,
    rev_p2: false,
    exp_p1: false,
    exp_p2: false,
    gen: 0,
  }

  pure def enqueue(q: Queue, entry: str): Queue =
    if (q.len == 0)
      q.with("len", 1).with("a", entry).with("snap_pos", if (entry == "snap") 0 else q.snap_pos)
    else (
      if (q.len == 1)
        q.with("len", 2).with("b", entry).with("snap_pos", if (entry == "snap") 1 else q.snap_pos)
      else
        q.with("len", 3).with("c", entry).with("snap_pos", if (entry == "snap") 2 else q.snap_pos)
    )

  pure def dequeue(q: Queue): Queue = {
    len: q.len - 1,
    a: q.b,
    b: q.c,
    c: "",
    snap_pos: if (q.snap_pos < 0) -1 else q.snap_pos - 1,
    coalesce: q.coalesce,
  }

  pure def queued(q: Queue, tag: str): bool = q.a == tag or q.b == tag or q.c == tag

  pure def offer_tag(id: str): str = if (id == "p1") "o:p1" else "o:p2"

  pure def apply_snap(p: Peer, saw: bool, was_revoked: bool, was_expired: bool): Peer =
    if (saw and (was_revoked or was_expired) and p.phase == "live")
      p.with("phase", "closed").with("closed_by", "snapshot").with("seen_when_closed", true).with("snap_cause", true)
    else p

  pure def apply_offer(p: Peer, selected: bool): Peer =
    if (selected and p.phase == "live" and not(p.offer_latched))
      p.with("offer", "o").with("latched_offer", "o").with("offer_latched", true)
    else p

  action init: bool = all {
    route' = { identity: "", holder: "", previous: "", authority: false, link: true, routed: false },
    lease' = Map("n1" -> true, "n2" -> true),
    peer' = Map("p1" -> blank, "p2" -> blank),
    queue' = empty_queue,
    capture' = no_capture,
    side' = { epoch: 1, ice: 0, answer: false, inbox_lost: false },
  }

  action replace_as(conn: str, node: str): bool = all {
    lease.get(node),
    conn != route.identity,
    route' = route
      .with("previous", route.identity)
      .with("identity", conn)
      .with("holder", node)
      .with("authority", true)
      .with("link", true)
      .with("routed", true),
    lease' = lease,
    peer' = peer,
    queue' = empty_queue,
    capture' = capture,
    side' = side.with("ice", 0).with("answer", false),
  }

  action replace_route: bool = {
    nondet conn = oneOf(conn_ids)
    nondet node = oneOf(node_ids)
    replace_as(conn, node)
  }

  /// A message or disconnect from the replaced connection does not change the new route.
  action late_as(conn: str): bool = all {
    route.previous != "",
    conn == route.previous,
    conn != route.identity,
    route' = route,
    lease' = lease,
    peer' = peer,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action late_message: bool = {
    nondet conn = oneOf(conn_ids)
    late_as(conn)
  }

  action cleanup_as(conn: str): bool = all {
    route.previous != "",
    conn == route.previous,
    conn != route.identity,
    route' = route,
    lease' = lease,
    peer' = peer,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action disconnect_cleanup: bool = {
    nondet conn = oneOf(conn_ids)
    cleanup_as(conn)
  }

  /// Another Team's connection is a different route and cannot replace this registration.
  action foreign_route: bool = all {
    route.identity != "",
    route' = route,
    lease' = lease,
    peer' = peer,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action lease_lost_as(node: str): bool = all {
    lease.get(node),
    lease' = lease.set(node, false),
    route' = if (route.holder == node) route.with("authority", false).with("link", false) else route,
    peer' = peer,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action lease_lost: bool = {
    nondet node = oneOf(node_ids)
    lease_lost_as(node)
  }

  action link_dead: bool = all {
    route.link,
    route.identity != "",
    route' = route.with("link", false),
    lease' = lease,
    peer' = peer,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action grant_as(id: str): bool = all {
    route.authority,
    route.link,
    peer.get(id).phase == "absent",
    side.epoch < 4,
    peer' = peer.set(id, blank.with("phase", "live").with("gen", side.epoch)),
    side' = side.with("epoch", side.epoch + 1),
    route' = route,
    lease' = lease,
    queue' = queue,
    capture' = capture,
  }

  action grant_peer: bool = {
    nondet id = oneOf(peer_ids)
    grant_as(id)
  }

  action revoke_db_as(id: str): bool = all {
    peer.get(id).phase == "live",
    not(peer.get(id).revoked),
    peer' = peer.set(id, peer.get(id).with("revoked", true)),
    route' = route,
    lease' = lease,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action revoke_db: bool = {
    nondet id = oneOf(peer_ids)
    revoke_db_as(id)
  }

  action expire_db_as(id: str): bool = all {
    peer.get(id).phase == "live",
    not(peer.get(id).expired),
    peer' = peer.set(id, peer.get(id).with("expired", true)),
    route' = route,
    lease' = lease,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action expire_db: bool = {
    nondet id = oneOf(peer_ids)
    expire_db_as(id)
  }

  action enqueue_offer_as(id: str): bool = all {
    route.authority,
    route.link,
    peer.get(id).phase == "live",
    not(peer.get(id).offer_latched),
    not(queued(queue, offer_tag(id))),
    queue.len < 3,
    queue' = enqueue(queue, offer_tag(id)),
    route' = route,
    lease' = lease,
    peer' = peer,
    capture' = capture,
    side' = side,
  }

  action enqueue_offer: bool = {
    nondet id = oneOf(peer_ids)
    enqueue_offer_as(id)
  }

  action take_snapshot: bool = all {
    route.authority,
    route.link,
    queue.snap_pos == -1,
    queue.len < 3,
    side.epoch < 4,
    queue' = enqueue(queue, "snap").with("coalesce", false),
    capture' = {
      seen_p1: peer.get("p1").phase != "absent",
      seen_p2: peer.get("p2").phase != "absent",
      rev_p1: peer.get("p1").revoked,
      rev_p2: peer.get("p2").revoked,
      exp_p1: peer.get("p1").expired,
      exp_p2: peer.get("p2").expired,
      gen: side.epoch,
    },
    side' = side.with("epoch", side.epoch + 1),
    route' = route,
    lease' = lease,
    peer' = peer,
  }

  action coalesce_reconcile: bool = all {
    route.authority,
    queue.snap_pos >= 0,
    not(queue.coalesce),
    queue' = queue.with("coalesce", true),
    route' = route,
    lease' = lease,
    peer' = peer,
    capture' = capture,
    side' = side,
  }

  action deliver: bool = all {
    route.authority,
    route.link,
    queue.len > 0,
    peer' = if (queue.a == "snap")
      Map(
        "p1" -> apply_snap(peer.get("p1"), capture.seen_p1, capture.rev_p1, capture.exp_p1),
        "p2" -> apply_snap(peer.get("p2"), capture.seen_p2, capture.rev_p2, capture.exp_p2),
      )
    else
      Map(
        "p1" -> apply_offer(peer.get("p1"), queue.a == "o:p1"),
        "p2" -> apply_offer(peer.get("p2"), queue.a == "o:p2"),
      ),
    queue' = dequeue(queue),
    route' = route,
    lease' = lease,
    capture' = capture,
    side' = side,
  }

  action trickle: bool = all {
    route.link,
    route.identity != "",
    not(side.answer),
    side.ice < 2,
    side' = side.with("ice", side.ice + 1),
    route' = route,
    lease' = lease,
    peer' = peer,
    queue' = queue,
    capture' = capture,
  }

  action deliver_answer: bool = all {
    route.authority,
    route.link,
    route.identity != "",
    not(side.answer),
    side' = side.with("answer", true),
    route' = route,
    lease' = lease,
    peer' = peer,
    queue' = queue,
    capture' = capture,
  }

  action overflow_as(id: str): bool = all {
    route.link,
    route.identity != "",
    side.ice == 2,
    peer.get(id).phase == "live",
    peer' = peer.set(id, peer.get(id).with("phase", "closed").with("closed_by", "overflow")),
    route' = route,
    lease' = lease,
    queue' = queue,
    capture' = capture,
    side' = side,
  }

  action peer_event_overflow: bool = {
    nondet id = oneOf(peer_ids)
    overflow_as(id)
  }

  action drop_inbox_as(id: str): bool = all {
    peer.get(id).offer_latched,
    not(side.inbox_lost),
    side' = side.with("inbox_lost", true),
    route' = route,
    lease' = lease,
    peer' = peer,
    queue' = queue,
    capture' = capture,
  }

  action drop_inbox: bool = {
    nondet id = oneOf(peer_ids)
    drop_inbox_as(id)
  }

  action open_replacement_as(id: str): bool = all {
    side.inbox_lost,
    route.authority,
    route.link,
    peer.get(id).phase == "absent",
    side.epoch < 4,
    peer' = peer.set(id, blank
      .with("phase", "live")
      .with("gen", side.epoch)
      .with("offer", "n")
      .with("latched_offer", "n")
      .with("offer_latched", true)),
    side' = side.with("epoch", side.epoch + 1),
    route' = route,
    lease' = lease,
    queue' = queue,
    capture' = capture,
  }

  action open_replacement: bool = {
    nondet id = oneOf(peer_ids)
    open_replacement_as(id)
  }

  action step: bool = any {
    replace_route,
    late_message,
    disconnect_cleanup,
    foreign_route,
    lease_lost,
    link_dead,
    grant_peer,
    revoke_db,
    expire_db,
    enqueue_offer,
    take_snapshot,
    coalesce_reconcile,
    deliver,
    trickle,
    deliver_answer,
    peer_event_overflow,
    drop_inbox,
    open_replacement,
  }

  val inv_route_identity: bool =
    (route.identity == "" or route.identity == "c1" or route.identity == "c2") and
    (route.holder == "" or route.holder == "n1" or route.holder == "n2") and
    ((route.identity == "") == (route.holder == "")) and
    (not(route.routed) or route.identity != "")

  val inv_authority_follows_lease: bool =
    not(route.authority) or (route.holder != "" and lease.get(route.holder))

  val inv_snapshot_before_grant: bool =
    queue.snap_pos < 0 or (
      (not(capture.seen_p1) or (peer.get("p1").gen > 0 and peer.get("p1").gen <= capture.gen)) and
      (not(capture.seen_p2) or (peer.get("p2").gen > 0 and peer.get("p2").gen <= capture.gen))
    )

  val inv_reconcile_closes_captured: bool = peer_ids.forall(id =>
    peer.get(id).closed_by != "snapshot" or (
      peer.get(id).phase == "closed" and peer.get(id).seen_when_closed and peer.get(id).snap_cause))

  val inv_one_snapshot: bool =
    queue.snap_pos >= -1 and queue.snap_pos < queue.len and
    (queue.snap_pos != 0 or queue.a == "snap") and
    (queue.snap_pos != 1 or queue.b == "snap") and
    (queue.snap_pos != 2 or queue.c == "snap") and
    ((if (queue.a == "snap") 1 else 0) + (if (queue.b == "snap") 1 else 0) + (if (queue.c == "snap") 1 else 0)) <= 1

  val inv_queue_bounded: bool =
    queue.len >= 0 and queue.len <= 3 and
    (queue.len == 0 or queue.a != "") and
    (queue.len <= 1 or queue.b != "") and
    (queue.len <= 2 or queue.c != "") and
    (queue.len > 0 or queue.a == "") and
    (queue.len > 1 or queue.b == "") and
    (queue.len > 2 or queue.c == "")

  val inv_offer_stable: bool = peer_ids.forall(id =>
    not(peer.get(id).offer_latched) or peer.get(id).offer == peer.get(id).latched_offer)

  val inv_route_survives: bool = peer_ids.forall(id =>
    peer.get(id).closed_by != "overflow" or route.identity != "")

  run stale_identity_cannot_fence_the_new_route = {
    init
      .then(replace_as("c1", "n1"))
      .then(replace_as("c2", "n2"))
      .then(late_as("c1"))
      .then(cleanup_as("c1"))
      .then(foreign_route)
      .then(link_dead)
      .then(lease_lost_as("n2"))
      .expect(route.identity == "c2" and route.holder == "n2" and route.routed and not(route.authority) and not(route.link))
      .then(grant_as("p1").fail())
  }

  run snapshot_before_grant_cannot_close_it = {
    init
      .then(replace_as("c1", "n1"))
      .then(grant_as("p1"))
      .then(take_snapshot)
      .then(grant_as("p2"))
      .then(enqueue_offer_as("p2"))
      .then(deliver)
      .expect(peer.get("p1").phase == "live" and peer.get("p2").phase == "live" and not(peer.get("p2").offer_latched))
      .then(deliver)
      .expect(peer.get("p2").offer == "o" and peer.get("p2").offer_latched and route.identity == "c1")
  }

  run missed_revocation_closes_on_reconcile = {
    init
      .then(replace_as("c1", "n1"))
      .then(grant_as("p1"))
      .then(grant_as("p2"))
      .then(revoke_db_as("p2"))
      .then(take_snapshot)
      .then(deliver)
      .expect(
        peer.get("p2").phase == "closed" and peer.get("p2").closed_by == "snapshot" and
        peer.get("p1").phase == "live" and route.identity == "c1")
  }

  run coalesce_keeps_snapshot_position = {
    init
      .then(replace_as("c1", "n1"))
      .then(grant_as("p1"))
      .then(enqueue_offer_as("p1"))
      .then(take_snapshot)
      .then(coalesce_reconcile)
      .then(grant_as("p2"))
      .then(enqueue_offer_as("p2"))
      .expect(queue.a == "o:p1" and queue.b == "snap" and queue.c == "o:p2" and queue.snap_pos == 1 and queue.coalesce)
      .then(deliver)
      .expect(queue.a == "snap" and queue.b == "o:p2" and queue.snap_pos == 0 and peer.get("p1").offer_latched)
      .then(deliver)
      .expect(queue.a == "o:p2" and queue.snap_pos == -1 and queue.coalesce and peer.get("p1").phase == "live" and peer.get("p2").phase == "live")
  }

  run early_ice_cannot_block_the_answer = {
    init
      .then(replace_as("c1", "n1"))
      .then(trickle)
      .then(trickle)
      .then(deliver_answer)
      .expect(side.answer and side.ice == 2 and route.identity == "c1")
  }

  run overflow_fails_the_peer_only = {
    init
      .then(replace_as("c1", "n1"))
      .then(grant_as("p1"))
      .then(grant_as("p2"))
      .then(trickle)
      .then(trickle)
      .then(overflow_as("p1"))
      .expect(peer.get("p1").phase == "closed" and peer.get("p1").closed_by == "overflow" and peer.get("p2").phase == "live" and route.identity == "c1" and route.routed)
  }

  run lost_negotiation_opens_a_new_peer = {
    init
      .then(replace_as("c1", "n1"))
      .then(grant_as("p1"))
      .then(enqueue_offer_as("p1"))
      .then(deliver)
      .expect(peer.get("p1").offer == "o" and peer.get("p1").offer_latched)
      .then(drop_inbox_as("p1"))
      .expect(peer.get("p1").offer == "o" and side.inbox_lost)
      .then(open_replacement_as("p2"))
      .expect(peer.get("p2").phase == "live" and peer.get("p2").offer == "n" and peer.get("p1").offer == "o")
  }
}
