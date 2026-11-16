// One WebRTC offer racing the withdrawal of its grant.
// Decisions live in agents/docs/webrtc-security.md. This module checks their
// interleavings; agents/docs/control-plane-verification.md owns the runs below.
module offer_revocation {
  // One grant, one offer request, and one daemon route. Four queued frames hold
  // the offer, two notices, and one snapshot. This is not a product limit.
  pure val OUTBOX: int = 4

  var grant: str
  var access: bool
  var notice: bool
  var request: str
  var outbox: List[str]
  var daemon: str

  action init: bool = all {
    grant' = "valid",
    access' = true,
    notice' = false,
    request' = "idle",
    outbox' = List(),
    daemon' = "absent",
  }

  /// The first authorization check.
  action offer_check: bool = all {
    request == "idle",
    request' = if (grant == "valid" and access) "checked" else "rejected",
    grant' = grant,
    access' = access,
    notice' = notice,
    outbox' = outbox,
    daemon' = daemon,
  }

  /// The registration gate orders the offer after earlier snapshots. It does not recheck the grant.
  action offer_send: bool = all {
    request == "checked",
    outbox.length() < OUTBOX,
    request' = "sent",
    outbox' = outbox.append("offer"),
    grant' = grant,
    access' = access,
    notice' = notice,
    daemon' = daemon,
  }

  /// Revocation commits the grant row and publishes one notice.
  action revoke: bool = all {
    grant == "valid",
    grant' = "revoked",
    notice' = true,
    access' = access,
    request' = request,
    outbox' = outbox,
    daemon' = daemon,
  }

  /// The login session expires or Team access is withdrawn. The grant row stays valid.
  action access_ends: bool = all {
    access,
    access' = false,
    grant' = grant,
    notice' = notice,
    request' = request,
    outbox' = outbox,
    daemon' = daemon,
  }

  /// A notice reaches the route outside the registration gate, so it can precede the offer.
  /// A full outbox requests a snapshot instead; `route_fence.qnt` owns that overflow.
  action notice_queued: bool = all {
    notice,
    outbox.length() < OUTBOX,
    notice' = false,
    outbox' = outbox.append("revoked"),
    grant' = grant,
    access' = access,
    request' = request,
    daemon' = daemon,
  }

  /// Heartbeat reconciliation reads the valid grants under the registration gate.
  action heartbeat: bool = all {
    outbox.length() < OUTBOX,
    outbox' = outbox.append(if (grant == "valid") "snapshot_with" else "snapshot_without"),
    grant' = grant,
    access' = access,
    notice' = notice,
    request' = request,
    daemon' = daemon,
  }

  /// The daemon checks expiry, not revocation. Closing an unknown peer is a no-op.
  pure def receive(peer: str, frame: str): str =
    if (frame == "offer") (if (peer == "absent") "live" else peer)
    else if (frame == "revoked" or frame == "snapshot_without") (if (peer == "live") "closed" else peer)
    else peer

  /// The daemon creates its peer from the offer and replies with an answer.
  action daemon_receive: bool = all {
    outbox.length() > 0,
    outbox' = outbox.tail(),
    daemon' = receive(daemon, outbox.head()),
    grant' = grant,
    access' = access,
    notice' = notice,
    request' = request,
  }

  /// Committing the answer locks an unrevoked grant row. A revoked grant fails the setup
  /// and notifies again, because the first notice can have closed nothing.
  action offer_commit: bool = all {
    request == "sent",
    daemon != "absent",
    request' = if (grant == "valid") "committed" else "failed",
    notice' = (notice or grant == "revoked"),
    grant' = grant,
    access' = access,
    outbox' = outbox,
    daemon' = daemon,
  }

  /// The final authorization check. A withdrawn login, access, or grant revokes and notifies.
  action offer_recheck: bool = all {
    request == "committed",
    request' = if (grant == "valid" and access) "answered" else "failed",
    grant' = if (grant == "valid" and access) grant else "revoked",
    notice' = (notice or not(grant == "valid" and access)),
    access' = access,
    outbox' = outbox,
    daemon' = daemon,
  }

  /// Timeout, a daemon error, or a lost route. The setup revokes its grant and notifies.
  action offer_abandoned: bool = all {
    request == "sent",
    request' = "failed",
    grant' = "revoked",
    notice' = true,
    access' = access,
    outbox' = outbox,
    daemon' = daemon,
  }

  action step: bool = any {
    offer_check,
    offer_send,
    revoke,
    access_ends,
    notice_queued,
    heartbeat,
    daemon_receive,
    offer_commit,
    offer_recheck,
    offer_abandoned,
  }

  val frames: Set[str] = Set("offer", "revoked", "snapshot_with", "snapshot_without")

  val offers: int = outbox.foldl(0, (count, frame) => if (frame == "offer") count + 1 else count)

  /// No queued frame, unqueued notice, or request awaiting a step remains.
  val quiescent: bool =
    outbox.length() == 0 and not(notice) and not(Set("checked", "sent", "committed").contains(request))

  /// Once in-flight work drains, a revoked grant has no live daemon peer.
  /// The heartbeat snapshot is a backstop, not the revocation path.
  val inv_revocation_is_prompt: bool = not(quiescent and grant == "revoked" and daemon == "live")

  /// A failed setup leaves no live daemon peer once in-flight work drains.
  val inv_failed_setup_closes: bool = not(quiescent and request == "failed" and daemon == "live")

  val inv_failed_revokes: bool = request != "failed" or grant == "revoked"

  val inv_closed_after_revocation: bool = daemon != "closed" or grant == "revoked"

  val inv_one_offer: bool =
    offers + (if (daemon == "absent") 0 else 1) ==
    (if (Set("idle", "checked", "rejected").contains(request)) 0 else 1)

  val inv_commit_follows_answer: bool =
    not(Set("committed", "answered").contains(request)) or daemon != "absent"

  val inv_domain: bool =
    Set("valid", "revoked").contains(grant) and
    Set("idle", "checked", "sent", "committed", "answered", "failed", "rejected").contains(request) and
    Set("absent", "live", "closed").contains(daemon) and
    outbox.length() <= OUTBOX and
    outbox.indices().forall(index => frames.contains(outbox[index]))

  run early_notice_is_repeated_after_the_answer = {
    init
      .then(offer_check)
      .then(revoke)
      .then(notice_queued)
      .then(offer_send)
      .then(daemon_receive)
      .expect(daemon == "absent" and outbox == List("offer"))
      .then(daemon_receive)
      .expect(daemon == "live" and grant == "revoked")
      .then(offer_commit)
      .expect(request == "failed" and notice and daemon == "live")
      .then(notice_queued)
      .then(daemon_receive)
      .expect(quiescent and daemon == "closed")
  }

  run ended_access_revokes_the_answered_grant = {
    init
      .then(offer_check)
      .then(offer_send)
      .then(daemon_receive)
      .then(offer_commit)
      .expect(request == "committed" and daemon == "live")
      .then(access_ends)
      .then(offer_recheck)
      .expect(request == "failed" and grant == "revoked" and notice)
      .then(notice_queued)
      .then(daemon_receive)
      .expect(quiescent and daemon == "closed")
  }

  run abandoned_offer_closes_the_late_daemon_peer = {
    init
      .then(offer_check)
      .then(offer_send)
      .then(offer_abandoned)
      .expect(request == "failed" and grant == "revoked" and daemon == "absent")
      .then(notice_queued)
      .expect(outbox == List("offer", "revoked"))
      .then(daemon_receive)
      .then(daemon_receive)
      .expect(quiescent and daemon == "closed")
  }

  run revoked_grant_sends_no_offer = {
    init
      .then(revoke)
      .then(offer_check)
      .expect(request == "rejected")
      .then(offer_send.fail())
  }

  run answered_offer_keeps_the_daemon_peer = {
    init
      .then(offer_check)
      .then(offer_send)
      .then(daemon_receive)
      .then(offer_commit)
      .then(offer_recheck)
      .expect(request == "answered" and daemon == "live")
      .then(heartbeat)
      .then(daemon_receive)
      .expect(quiescent and daemon == "live" and grant == "valid")
  }
}
