// One fixed4-v1 peer and two logical streams.
// Decisions live in agents/docs/webrtc-security.md. This module checks their
// interleavings; agents/docs/control-plane-verification.md owns the runs below.
module mux_streams {
  pure val stream_ids = Set("s1", "s2")

  type Stream = { open: bool }

  type GrantView = {
    actor: str,
    actions: str,
    expiry: int,
    accepted: bool,
    accepted_work: bool,
  }

  type Mode = {
    peer_open: bool,
    profile: str,
    legacy_ok: bool,
    business: bool,
    released: bool,
    signaling: bool,
  }

  var grant: GrantView
  var mode: Mode
  var stream: str -> Stream

  pure val shut: Stream = { open: false }

  action init: bool = all {
    grant' = { actor: "u1", actions: "use", expiry: 1, accepted: false, accepted_work: false },
    mode' = { peer_open: false, profile: "", legacy_ok: false, business: false, released: false, signaling: true },
    stream' = Map("s1" -> shut, "s2" -> shut),
  }

  action choose_fixed4: bool = all {
    mode.profile == "",
    not(mode.released),
    mode' = mode.with("profile", "fixed4").with("peer_open", true),
    grant' = grant,
    stream' = stream,
  }

  action open_as(id: str): bool = all {
    mode.profile == "fixed4",
    mode.peer_open,
    not(stream.get(id).open),
    stream' = stream.set(id, { open: true }),
    grant' = grant,
    mode' = mode,
  }

  action open_stream: bool = {
    nondet id = oneOf(stream_ids)
    open_as(id)
  }

  action close_as(id: str): bool = all {
    stream.get(id).open,
    mode.peer_open,
    stream' = stream.set(id, shut),
    grant' = grant,
    mode' = mode,
  }

  action close_stream: bool = {
    nondet id = oneOf(stream_ids)
    close_as(id)
  }

  action accept_work: bool = all {
    mode.peer_open,
    not(grant.accepted),
    grant' = grant.with("accepted", true).with("accepted_work", true),
    mode' = mode,
    stream' = stream,
  }

  action revoke_peer: bool = all {
    mode.signaling,
    mode.peer_open,
    mode' = mode.with("peer_open", false).with("released", true),
    stream' = Map("s1" -> shut, "s2" -> shut),
    grant' = grant,
  }

  action authorization_due: bool = all {
    mode.peer_open,
    mode' = mode.with("peer_open", false).with("released", true),
    stream' = Map("s1" -> shut, "s2" -> shut),
    grant' = grant,
  }

  /// An explicit unsupported-profile rejection may select the legacy peer before business traffic.
  action unsupported_profile: bool = all {
    mode.profile == "",
    not(mode.business),
    not(mode.released),
    mode' = mode.with("profile", "legacy").with("legacy_ok", true),
    grant' = grant,
    stream' = stream,
  }

  /// Authentication, revocation, a network timeout, or malformed traffic does not select legacy.
  action auth_failure: bool = all {
    mode.profile != "legacy",
    mode.profile != "failed",
    not(mode.business),
    mode' = mode.with("profile", "failed").with("peer_open", false).with("released", true),
    stream' = Map("s1" -> shut, "s2" -> shut),
    grant' = grant,
  }

  action business_request: bool = all {
    not(mode.business),
    (mode.profile == "fixed4" and mode.peer_open) or mode.profile == "legacy",
    mode' = mode.with("business", true),
    grant' = grant,
    stream' = stream,
  }

  action signaling_down: bool = all {
    mode.signaling,
    mode' = mode.with("signaling", false),
    grant' = grant,
    stream' = stream,
  }

  action signaling_up: bool = all {
    not(mode.signaling),
    mode' = mode.with("signaling", true),
    grant' = grant,
    stream' = stream,
  }

  action step: bool = any {
    choose_fixed4,
    open_stream,
    close_stream,
    accept_work,
    revoke_peer,
    authorization_due,
    unsupported_profile,
    auth_failure,
    business_request,
    signaling_down,
    signaling_up,
  }

  val inv_grant_stable: bool = grant.actor == "u1" and grant.actions == "use" and grant.expiry == 1

  val inv_release_closes_streams: bool =
    mode.peer_open or (not(stream.get("s1").open) and not(stream.get("s2").open))

  val inv_legacy_before_business: bool = mode.profile != "legacy" or mode.legacy_ok

  val inv_accepted_work_survives: bool = not(grant.accepted) or grant.accepted_work

  run close_stream_keeps_sibling = {
    init
      .then(choose_fixed4)
      .then(open_as("s1"))
      .then(open_as("s2"))
      .then(accept_work)
      .then(signaling_down)
      .then(close_as("s1"))
      .expect(
        not(stream.get("s1").open) and stream.get("s2").open and mode.peer_open and
        grant.accepted_work and grant.actor == "u1" and grant.expiry == 1 and not(mode.signaling))
  }

  run peer_close_releases_every_stream = {
    init
      .then(choose_fixed4)
      .then(open_as("s1"))
      .then(open_as("s2"))
      .then(accept_work)
      .then(revoke_peer)
      .expect(
        not(mode.peer_open) and not(stream.get("s1").open) and not(stream.get("s2").open) and
        grant.accepted_work and grant.expiry == 1 and mode.released)
  }

  run unsupported_profile_selects_legacy = {
    init
      .then(unsupported_profile)
      .expect(mode.profile == "legacy" and mode.legacy_ok and not(mode.business))
      .then(business_request)
      .expect(mode.business and mode.profile == "legacy")
      .then(unsupported_profile.fail())
  }

  run auth_failure_stays_failed = {
    init
      .then(auth_failure)
      .expect(mode.profile == "failed" and not(mode.legacy_ok) and not(mode.peer_open) and not(stream.get("s1").open))
      .then(unsupported_profile.fail())
  }
}
