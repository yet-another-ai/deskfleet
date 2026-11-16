// One local claim secret from prepareLocal through its window.
// Decisions live in agents/docs/webrtc-security.md. This module checks their
// interleavings; agents/docs/control-plane-verification.md owns the runs below.
module local_claim {
  type Claim = {
    kind: str,
    phase: str,
    spent: bool,
    sealed: bool,
  }

  var claim: Claim

  action init: bool = all {
    claim' = { kind: "", phase: "absent", spent: false, sealed: false },
  }

  /// prepareLocal records the secret before the socket is claimed.
  action issue_local: bool = all {
    claim.kind == "",
    claim' = { kind: "local", phase: "prepared", spent: true, sealed: false },
  }

  /// A WebRTC grant is rejected before the secret is recorded.
  action issue_webrtc: bool = all {
    claim.kind == "",
    claim' = { kind: "webrtc", phase: "absent", spent: false, sealed: false },
  }

  action open_local: bool = all {
    claim.kind == "local",
    claim.phase == "prepared",
    not(claim.sealed),
    claim' = claim.with("phase", "claimed"),
  }

  /// The unclaimed window elapsed. The secret stays spent.
  action claim_due: bool = all {
    claim.kind == "local",
    claim.phase == "prepared",
    claim' = claim.with("phase", "closed").with("sealed", true),
  }

  action authorization_due: bool = all {
    claim.kind == "local",
    claim.phase == "prepared" or claim.phase == "claimed",
    claim' = claim.with("phase", "closed").with("sealed", true),
  }

  action close_claimed: bool = all {
    claim.phase == "claimed",
    claim' = claim.with("phase", "closed").with("sealed", true),
  }

  /// A sealed secret, or a WebRTC grant that was never recorded, stays unchanged.
  action spent_secret_stays: bool = all {
    claim.sealed or claim.kind == "webrtc",
    claim' = claim,
  }

  action step: bool = any {
    issue_local,
    issue_webrtc,
    open_local,
    claim_due,
    authorization_due,
    close_claimed,
    spent_secret_stays,
  }

  val inv_blank: bool =
    claim.kind != "" or (claim.phase == "absent" and not(claim.spent) and not(claim.sealed))

  val inv_local_spent: bool = claim.kind != "local" or claim.spent

  val inv_webrtc_unspent: bool =
    claim.kind != "webrtc" or (claim.phase == "absent" and not(claim.spent) and not(claim.sealed))

  val inv_prepared: bool =
    claim.phase != "prepared" or (claim.kind == "local" and claim.spent and not(claim.sealed))

  val inv_claimed: bool =
    claim.phase != "claimed" or (claim.kind == "local" and claim.spent and not(claim.sealed))

  val inv_sealed: bool = not(claim.sealed) or (claim.phase == "closed" and claim.spent)

  val inv_domain: bool =
    (claim.kind == "" or claim.kind == "local" or claim.kind == "webrtc") and
    (claim.phase == "absent" or claim.phase == "prepared" or claim.phase == "claimed" or claim.phase == "closed")

  run unclaimed_window_spends_the_secret = {
    init
      .then(issue_local)
      .expect(claim.kind == "local" and claim.phase == "prepared" and claim.spent and not(claim.sealed))
      .then(claim_due)
      .expect(claim.phase == "closed" and claim.spent and claim.sealed)
      .then(open_local.fail())
  }

  run unclaimed_window_rejects_another_prepare = {
    init
      .then(issue_local)
      .then(claim_due)
      .expect(claim.spent and claim.sealed)
      .then(issue_local.fail())
  }

  run second_open_fails = {
    init
      .then(issue_local)
      .then(open_local)
      .expect(claim.phase == "claimed" and claim.spent and not(claim.sealed))
      .then(open_local.fail())
  }

  run claimed_close_spends_the_secret = {
    init
      .then(issue_local)
      .then(open_local)
      .then(close_claimed)
      .expect(claim.phase == "closed" and claim.spent and claim.sealed and claim.kind == "local")
      .then(open_local.fail())
  }

  run authorization_due_spends_the_secret = {
    init
      .then(issue_local)
      .then(open_local)
      .then(authorization_due)
      .expect(claim.phase == "closed" and claim.spent and claim.sealed and claim.kind == "local")
      .then(open_local.fail())
  }

  run webrtc_grant_cannot_be_claimed = {
    init
      .then(issue_webrtc)
      .expect(claim.kind == "webrtc" and claim.phase == "absent" and not(claim.spent) and not(claim.sealed))
      .then(open_local.fail())
  }
}
