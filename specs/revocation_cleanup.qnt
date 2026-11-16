// Daemon cleanup after credential rejection, and the re-enrollment that awaits it.
// Decisions live in agents/docs/architecture.md. This module checks their
// interleavings; agents/docs/control-plane-verification.md owns the runs below.
module revocation_cleanup {
  // One registration. Its peers are one set. Faults stop once; healing is permanent.
  type Cleanup = {
    memo: str,
    closing: str,
    saving: str,
  }

  type Attempt = {
    running: bool,
    retried: bool,
    healthy: bool,
  }

  var credential: str
  var peers: str
  var cleanup: Cleanup
  var attempt: Attempt
  var env: str
  var healthy_failed: bool

  val idle_cleanup: Cleanup = { memo: "none", closing: "idle", saving: "idle" }
  val started_cleanup: Cleanup = { memo: "pending", closing: "pending", saving: "pending" }
  val no_attempt: Attempt = { running: false, retried: false, healthy: false }

  action init: bool = all {
    credential' = "active",
    peers' = "open",
    cleanup' = idle_cleanup,
    attempt' = no_attempt,
    env' = "faulty",
    healthy_failed' = false,
  }

  action open_peer: bool = all {
    credential == "active",
    peers == "closed",
    peers' = "open",
    credential' = credential,
    cleanup' = cleanup,
    attempt' = attempt,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  /// 4401, 4403, or a 401 for the current credential starts one cleanup.
  /// A later rejection returns that same memo.
  action rejected: bool = all {
    credential == "active",
    credential' = "revoked",
    cleanup' = started_cleanup,
    peers' = peers,
    attempt' = attempt,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  /// Each close removes its peer before awaiting resources, so the set empties either way.
  action close_ok: bool = all {
    cleanup.closing == "pending",
    cleanup' = cleanup.with("closing", "ok"),
    peers' = "closed",
    credential' = credential,
    attempt' = attempt,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  /// Only an open peer can fail to close. Closing an empty set resolves.
  action close_fails: bool = all {
    cleanup.closing == "pending",
    env == "faulty",
    peers == "open",
    cleanup' = cleanup.with("closing", "failed"),
    peers' = "closed",
    credential' = credential,
    attempt' = attempt,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  /// Persist the revoked credential.
  action save_ok: bool = all {
    cleanup.saving == "pending",
    cleanup' = cleanup.with("saving", "ok"),
    credential' = credential,
    peers' = peers,
    attempt' = attempt,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  action save_fails: bool = all {
    cleanup.saving == "pending",
    env == "faulty",
    cleanup' = cleanup.with("saving", "failed"),
    credential' = credential,
    peers' = peers,
    attempt' = attempt,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  /// The memo settles only after both steps finish, and resolves only if both did.
  action settle: bool = all {
    cleanup.memo == "pending",
    cleanup.closing == "ok" or cleanup.closing == "failed",
    cleanup.saving == "ok" or cleanup.saving == "failed",
    cleanup' = cleanup.with(
      "memo",
      if (cleanup.closing == "ok" and cleanup.saving == "ok") "resolved" else "rejected"),
    credential' = credential,
    peers' = peers,
    attempt' = attempt,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  action heal: bool = all {
    env == "faulty",
    env' = "healthy",
    credential' = credential,
    peers' = peers,
    cleanup' = cleanup,
    attempt' = attempt,
    healthy_failed' = healthy_failed,
  }

  /// enroll() reaches its await on the memo. `healthy` records that faults had stopped.
  action enroll_start: bool = all {
    credential == "revoked",
    not(attempt.running),
    attempt' = { running: true, retried: false, healthy: env == "healthy" },
    credential' = credential,
    peers' = peers,
    cleanup' = cleanup,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  /// A rejected memo is replaced by a new cleanup, once per attempt.
  action enroll_retry: bool = all {
    attempt.running,
    not(attempt.retried),
    cleanup.memo == "rejected",
    cleanup' = started_cleanup,
    attempt' = attempt.with("retried", true),
    credential' = credential,
    peers' = peers,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  /// The retried cleanup failed too. Only this attempt fails; the next one retries.
  action enroll_gives_up: bool = all {
    attempt.running,
    attempt.retried,
    cleanup.memo == "rejected",
    attempt' = no_attempt,
    healthy_failed' = (healthy_failed or attempt.healthy),
    credential' = credential,
    peers' = peers,
    cleanup' = cleanup,
    env' = env,
  }

  /// Verification or the new credential write failed. The cleanup stays resolved.
  action enroll_fails: bool = all {
    attempt.running,
    cleanup.memo == "resolved",
    env == "faulty",
    attempt' = no_attempt,
    healthy_failed' = (healthy_failed or attempt.healthy),
    credential' = credential,
    peers' = peers,
    cleanup' = cleanup,
    env' = env,
  }

  /// The new credential is saved and the memo cleared.
  action enroll_succeeds: bool = all {
    attempt.running,
    cleanup.memo == "resolved",
    credential' = "active",
    cleanup' = idle_cleanup,
    attempt' = no_attempt,
    peers' = peers,
    env' = env,
    healthy_failed' = healthy_failed,
  }

  action step: bool = any {
    open_peer,
    rejected,
    close_ok,
    close_fails,
    save_ok,
    save_fails,
    settle,
    heal,
    enroll_start,
    enroll_retry,
    enroll_gives_up,
    enroll_fails,
    enroll_succeeds,
  }

  val settled: Set[str] = Set("ok", "failed")

  /// An attempt that starts after faults stop succeeds without a daemon restart.
  val inv_healthy_enroll_succeeds: bool = not(healthy_failed)

  /// No step of a settled memo is still writing, so a retry never overlaps it.
  val inv_settles_after_both: bool =
    cleanup.memo == "none" or cleanup.memo == "pending" or
    (settled.contains(cleanup.closing) and settled.contains(cleanup.saving))

  val inv_resolved_is_clean: bool =
    cleanup.memo != "resolved" or
    (cleanup.closing == "ok" and cleanup.saving == "ok" and peers == "closed")

  val inv_revoked_has_cleanup: bool =
    if (credential == "active") cleanup == idle_cleanup
    else cleanup.memo != "none" and cleanup.closing != "idle" and cleanup.saving != "idle"

  val inv_closed_after_close: bool = not(settled.contains(cleanup.closing)) or peers == "closed"

  val inv_attempt: bool =
    if (attempt.running) credential == "revoked" else attempt == no_attempt

  val inv_domain: bool =
    Set("active", "revoked").contains(credential) and
    Set("open", "closed").contains(peers) and
    Set("faulty", "healthy").contains(env) and
    Set("none", "pending", "resolved", "rejected").contains(cleanup.memo) and
    Set("idle", "pending", "ok", "failed").contains(cleanup.closing) and
    Set("idle", "pending", "ok", "failed").contains(cleanup.saving)

  run failed_cleanup_is_retried_by_reenrollment = {
    init
      .then(rejected)
      .then(close_fails)
      .then(save_ok)
      .then(settle)
      .expect(credential == "revoked" and cleanup.memo == "rejected" and peers == "closed")
      .then(heal)
      .then(enroll_start)
      .then(enroll_retry)
      .expect(attempt.running and attempt.retried and cleanup == started_cleanup)
      .then(close_ok)
      .then(save_ok)
      .then(settle)
      .then(enroll_succeeds)
      .expect(credential == "active" and cleanup == idle_cleanup and not(attempt.running))
  }

  run reenrollment_waits_for_pending_cleanup = {
    init
      .then(rejected)
      .then(enroll_start)
      .expect(attempt.running and cleanup.memo == "pending")
      .then(enroll_succeeds.fail())
  }

  run cleanup_settles_after_both_steps = {
    init
      .then(rejected)
      .then(close_fails)
      .expect(cleanup.closing == "failed" and cleanup.saving == "pending" and peers == "closed")
      .then(settle.fail())
  }

  run faulty_retry_fails_only_that_attempt = {
    init
      .then(rejected)
      .then(close_fails)
      .then(save_ok)
      .then(settle)
      .then(enroll_start)
      .then(enroll_retry)
      .then(close_ok)
      .then(save_fails)
      .then(settle)
      .then(enroll_gives_up)
      .expect(
        credential == "revoked" and cleanup.memo == "rejected" and not(attempt.running) and
        not(healthy_failed))
      .then(heal)
      .then(enroll_start)
      .then(enroll_retry)
      .then(close_ok)
      .then(save_ok)
      .then(settle)
      .then(enroll_succeeds)
      .expect(credential == "active" and cleanup == idle_cleanup)
  }

  run reenrolled_registration_opens_peers = {
    init
      .then(rejected)
      .then(heal)
      .then(close_ok)
      .then(save_ok)
      .then(settle)
      .then(enroll_start)
      .then(enroll_succeeds)
      .then(open_peer)
      .expect(credential == "active" and peers == "open" and cleanup == idle_cleanup)
  }
}
