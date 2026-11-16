// Credential rejection versus a retryable signaling close.
// Decisions live in agents/docs/architecture.md and
// agents/docs/webrtc-security.md. This module checks their interleavings;
// agents/docs/control-plane-verification.md owns the runs below.
module credential_close {
  // One re-enrollment keeps the route finite. This is not a product limit.
  type Credential = {
    generation: int,
    revoked: bool,
  }

  type Peer = {
    phase: str,
    closed_by: str,
    expiry: int,
    accepted: bool,
    accepted_work: bool,
  }

  var link: str
  var credential: Credential
  var peer: Peer
  var admission: str
  var machine: str

  action init: bool = all {
    link' = "up",
    credential' = { generation: 0, revoked: false },
    peer' = { phase: "absent", closed_by: "", expiry: 1, accepted: false, accepted_work: false },
    admission' = "hello",
    machine' = "m1",
  }

  action accept_work: bool = all {
    peer.phase == "established",
    not(peer.accepted),
    peer' = peer.with("accepted", true).with("accepted_work", true),
    link' = link,
    credential' = credential,
    admission' = admission,
    machine' = machine,
  }

  /// A network blip during authenticate is 1012. The machine identity stays.
  action hello_blip: bool = all {
    admission == "hello",
    link == "up",
    not(credential.revoked),
    link' = "down",
    credential' = credential,
    peer' = peer,
    admission' = admission,
    machine' = machine,
  }

  /// An invalid authenticate frame is 4401. Logout keeps the same machine identity.
  action hello_reject: bool = all {
    admission == "hello",
    link == "up",
    not(credential.revoked),
    link' = "down",
    credential' = credential.with("revoked", true),
    peer' = peer.with("phase", "closed").with("closed_by", "credential"),
    admission' = admission,
    machine' = machine,
  }

  action hello_ready: bool = all {
    admission == "hello",
    link == "up",
    not(credential.revoked),
    peer.phase == "absent",
    admission' = "ready",
    peer' = peer.with("phase", "established"),
    link' = link,
    credential' = credential,
    machine' = machine,
  }

  /// 1012, transport loss, and a link declared dead reconnect with the same credential.
  action retryable_close: bool = all {
    admission == "ready",
    link == "up",
    not(credential.revoked),
    link' = "down",
    credential' = credential,
    peer' = peer,
    admission' = admission,
    machine' = machine,
  }

  action reconnect: bool = all {
    link == "down",
    not(credential.revoked),
    link' = "up",
    credential' = credential,
    peer' = peer,
    admission' = admission,
    machine' = machine,
  }

  /// 4401 and 4403 retire the current credential and close this registration's peers.
  action credential_rejected: bool = all {
    admission == "ready",
    link == "up",
    not(credential.revoked),
    link' = "down",
    credential' = credential.with("revoked", true),
    peer' = peer.with("phase", "closed").with("closed_by", "credential"),
    admission' = admission,
    machine' = machine,
  }

  action reenroll: bool = all {
    credential.revoked,
    credential.generation < 1,
    credential' = { generation: credential.generation + 1, revoked: false },
    link' = "up",
    peer' = peer,
    admission' = admission,
    machine' = machine,
  }

  /// A rejection for the retired token leaves the re-enrolled credential in place.
  action late_rejection: bool = all {
    credential.generation == 1,
    not(credential.revoked),
    credential' = credential,
    link' = link,
    peer' = peer,
    admission' = admission,
    machine' = machine,
  }

  /// The one modeled re-enrollment has been rejected. That credential stays revoked.
  action rejected_credential_stays: bool = all {
    credential.revoked,
    credential.generation == 1,
    credential' = credential,
    link' = link,
    peer' = peer,
    admission' = admission,
    machine' = machine,
  }

  action step: bool = any {
    hello_blip,
    hello_reject,
    hello_ready,
    accept_work,
    retryable_close,
    reconnect,
    credential_rejected,
    reenroll,
    late_rejection,
    rejected_credential_stays,
  }

  val inv_expiry_fixed: bool = peer.expiry == 1

  val inv_accepted_work_survives: bool = not(peer.accepted) or peer.accepted_work

  val inv_close_cause: bool =
    if (peer.phase == "closed") peer.closed_by == "credential"
    else if (peer.phase == "established" or peer.phase == "absent") peer.closed_by == ""
    else false

  val inv_revoked_closes: bool =
    not(credential.revoked) or (peer.phase == "closed" and link == "down")

  val inv_reenrolled_stays_closed: bool =
    credential.generation == 0 or (peer.phase == "closed" and peer.closed_by == "credential")

  val inv_credential_domain: bool =
    (credential.generation == 0 or credential.generation == 1) and
    (link == "up" or link == "down") and
    (admission == "hello" or admission == "ready") and
    machine == "m1" and
    (admission == "ready" or peer.phase != "established")

  run hello_blip_reconnects_the_same_machine = {
    init
      .then(hello_blip)
      .expect(
        admission == "hello" and link == "down" and not(credential.revoked) and machine == "m1" and
        peer.phase == "absent" and credential.generation == 0)
      .then(reconnect)
      .expect(
        admission == "hello" and link == "up" and not(credential.revoked) and machine == "m1" and
        peer.phase == "absent")
      .then(hello_ready)
      .expect(admission == "ready" and peer.phase == "established" and machine == "m1" and not(credential.revoked))
  }

  run hello_reject_keeps_the_machine_identity = {
    init
      .then(hello_reject)
      .expect(
        admission == "hello" and credential.revoked and link == "down" and machine == "m1" and
        peer.phase == "closed" and peer.closed_by == "credential")
      .then(reconnect.fail())
  }

  run hello_reject_reenrolls_the_same_machine = {
    init
      .then(hello_reject)
      .then(reenroll)
      .expect(
        credential.generation == 1 and not(credential.revoked) and machine == "m1" and
        peer.phase == "closed" and admission == "hello" and link == "up")
      .then(hello_ready.fail())
  }

  run retryable_close_keeps_the_peer = {
    init
      .then(hello_ready)
      .then(accept_work)
      .then(retryable_close)
      .expect(
        link == "down" and not(credential.revoked) and credential.generation == 0 and
        peer.phase == "established" and peer.expiry == 1 and peer.accepted_work)
      .then(reconnect)
      .expect(
        link == "up" and not(credential.revoked) and peer.phase == "established" and
        peer.expiry == 1 and peer.accepted_work)
  }

  run credential_rejection_closes_peers_without_reconnect = {
    init
      .then(hello_ready)
      .then(accept_work)
      .then(credential_rejected)
      .expect(
        credential.revoked and link == "down" and peer.phase == "closed" and
        peer.closed_by == "credential" and peer.expiry == 1 and peer.accepted_work)
      .then(reconnect.fail())
  }

  run late_rejection_keeps_the_reenrolled_credential = {
    init
      .then(hello_ready)
      .then(accept_work)
      .then(credential_rejected)
      .then(reenroll)
      .expect(
        credential.generation == 1 and not(credential.revoked) and link == "up" and
        peer.phase == "closed" and peer.closed_by == "credential" and peer.accepted_work and peer.expiry == 1)
      .then(late_rejection)
      .expect(
        credential.generation == 1 and not(credential.revoked) and peer.phase == "closed" and
        peer.accepted_work and peer.expiry == 1)
  }
}
