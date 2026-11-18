// A granted peer whose setup and failure cleanup can fail independently.
// This models the HTTP result as well as resource cleanup: a secondary failure
// must not replace the operation's original error.
// Setup covers TURN issuance, local attachment, and SDP negotiation. The model
// starts after the grant exists and the initial online check has passed.
module peer_creation_failure {
  var phase: str
  var primary: str
  var cleanup: str
  var revoked: bool
  var notified: bool
  var router_healthy: bool
  var response: str

  action init: bool = all {
    phase' = "reserved",
    primary' = "",
    cleanup' = "",
    revoked' = false,
    notified' = false,
    router_healthy' = true,
    response' = "",
  }

  action setup_fails_with(code: str): bool = all {
    phase == "reserved",
    phase' = "revoking",
    primary' = code,
    cleanup' = cleanup,
    revoked' = revoked,
    notified' = notified,
    router_healthy' = router_healthy,
    response' = response,
  }

  action setup_fails: bool = {
    nondet code = Set("turn_service_unavailable", "invalid_request", "not_found").oneOf()
    setup_fails_with(code)
  }

  action router_fails: bool = all {
    router_healthy,
    router_healthy' = false,
    phase' = phase,
    primary' = primary,
    cleanup' = cleanup,
    revoked' = revoked,
    notified' = notified,
    response' = response,
  }

  action revoke_ok: bool = all {
    phase == "revoking",
    phase' = "notifying",
    revoked' = true,
    primary' = primary,
    cleanup' = cleanup,
    notified' = notified,
    router_healthy' = router_healthy,
    response' = response,
  }

  action revoke_fails: bool = all {
    phase == "revoking",
    phase' = "done",
    cleanup' = "internal",
    response' = primary,
    primary' = primary,
    revoked' = revoked,
    notified' = notified,
    router_healthy' = router_healthy,
  }

  action notify_ok: bool = all {
    phase == "notifying",
    router_healthy,
    phase' = "done",
    notified' = true,
    response' = primary,
    primary' = primary,
    cleanup' = cleanup,
    revoked' = revoked,
    router_healthy' = router_healthy,
  }

  action notify_fails: bool = all {
    phase == "notifying",
    not(router_healthy),
    phase' = "done",
    cleanup' = "machine_offline",
    response' = primary,
    primary' = primary,
    revoked' = revoked,
    notified' = notified,
    router_healthy' = router_healthy,
  }

  action step: bool = any {
    setup_fails,
    router_fails,
    revoke_ok,
    revoke_fails,
    notify_ok,
    notify_fails,
  }

  val inv_primary_error_preserved: bool = phase != "done" or response == primary
  val inv_notification_follows_revoke: bool = not(notified) or revoked
  val inv_failed_notice_keeps_revocation: bool = cleanup != "machine_offline" or revoked
  val inv_no_false_cleanup_success: bool =
    phase != "done" or cleanup != "" or (revoked and notified)
  val inv_domain: bool =
    Set("reserved", "revoking", "notifying", "done").contains(phase) and
    Set("", "turn_service_unavailable", "invalid_request", "not_found").contains(primary) and
    Set("", "internal", "machine_offline").contains(cleanup) and
    Set("", "turn_service_unavailable", "invalid_request", "not_found").contains(response)

  run failed_revocation_preserves_turn_error = {
    init
      .then(setup_fails_with("turn_service_unavailable"))
      .then(revoke_fails)
      .expect(response == "turn_service_unavailable" and cleanup == "internal")
      .expect(not(revoked) and not(notified))
  }

  run node_failure_does_not_relabel_turn_failure_as_machine_offline = {
    init
      .then(router_fails)
      .then(setup_fails_with("turn_service_unavailable"))
      .then(revoke_ok)
      .then(notify_fails)
      .expect(response == "turn_service_unavailable" and cleanup == "machine_offline")
      .expect(revoked and not(notified))
  }

  run daemon_rejection_survives_failed_notification = {
    init
      .then(setup_fails_with("invalid_request"))
      .then(revoke_ok)
      .then(router_fails)
      .then(notify_fails)
      .expect(response == "invalid_request" and revoked and not(notified))
  }

  run withdrawn_grant_keeps_its_authorization_error = {
    init
      .then(setup_fails_with("not_found"))
      .then(revoke_ok)
      .then(router_fails)
      .then(notify_fails)
      .expect(response == "not_found" and revoked and not(notified))
  }

  run successful_cleanup_still_revokes_and_notifies = {
    init
      .then(setup_fails_with("turn_service_unavailable"))
      .then(revoke_ok)
      .then(notify_ok)
      .expect(response == "turn_service_unavailable" and revoked and notified)
      .expect(cleanup == "")
  }
}
