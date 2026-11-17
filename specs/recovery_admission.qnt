// New machine operations during a known client recovery. Existing authorized
// peer traffic and daemon work are outside this admission gate and survive it.
// One Team/Machine is modeled; runtime roster entries are keyed by Team and
// account/recovery generation. No claim is made that a fresh online snapshot
// prevents a subsequent daemon outage or every possible HTTP 503.
module recovery_admission {
  type State = {
    phase: str,
    epoch: int,
    roster_epoch: int,
    read_epoch: int,
    read_pending: bool,
    late_pending: bool,
    read_online: bool,
    cached_online: bool,
    route_online: bool,
    sent: bool,
    unsafe_dispatch: bool,
    peer_live: bool,
    work_running: bool,
  }
  var s: State
  action init = s' = {
    phase: "ready", epoch: 0, roster_epoch: 0, read_epoch: 0,
    read_pending: false, late_pending: false, read_online: true,
    cached_online: true, route_online: true,
    sent: false, unsafe_dispatch: false, peer_live: true, work_running: true,
  }
  // A visible native foreground event and desktop power resume have this same
  // effect as browser resume; neither needs a visibilitychange event first.
  action resume = all {
    s.phase != "disposed", s.epoch < 2,
    s' = s.with("phase", "probing").with("epoch", s.epoch + 1)
      .with("late_pending", s.late_pending or s.read_pending).with("read_pending", false),
  }
  action route_lost = all {
    s.route_online,
    s' = s.with("route_online", false),
  }
  action probe_ok = all {
    s.phase == "probing",
    s' = s.with("phase", "ready"),
  }
  action probe_miss = all {
    s.phase == "probing",
    s' = s.with("phase", "down"),
  }
  action reconnect = all {
    s.phase == "down",
    s' = s.with("phase", "ready"),
  }
  action roster_start = all {
    s.phase == "ready", not(s.read_pending),
    s' = s.with("read_pending", true).with("read_epoch", s.epoch)
      .with("read_online", s.route_online),
  }
  // Aborting a fetch settles its waiters, but the transport may still deliver
  // a late result. Such a result cannot certify a later recovery/account epoch.
  action roster_finish = all {
    s.read_pending,
    s' = if (s.read_epoch == s.epoch and s.phase == "ready")
      s.with("read_pending", false).with("roster_epoch", s.read_epoch)
        .with("cached_online", s.read_online)
      else s.with("read_pending", false),
  }
  // New reads need not wait for the aborted transport. Older completions are
  // fenced by identity, including when a newer current roster already finished.
  action late_roster_finish = all {
    s.late_pending,
    s' = s.with("late_pending", false),
  }
  action roster_failed = all {
    s.read_pending,
    s' = s.with("read_pending", false),
  }
  // Retire this admission gate/client object. Disposed clients cannot resume.
  // Account changes use this same invalidation in code; their authorization
  // revocations are owned by credential_close and grant_lifecycle, not this model.
  action dispose = all {
    s.phase != "disposed", s.epoch < 2,
    s' = s.with("phase", "disposed").with("epoch", s.epoch + 1)
      .with("late_pending", s.late_pending or s.read_pending).with("read_pending", false),
  }
  // Checking at dispatch also covers recovery between roster completion and
  // sending a POST (for example while cookie-auth fetches its CSRF token).
  action dispatch = all {
    s.cached_online, not(s.sent),
    s.phase == "ready", s.roster_epoch == s.epoch,
    s' = s.with("sent", true).with("unsafe_dispatch",
      s.unsafe_dispatch or s.phase != "ready" or s.roster_epoch != s.epoch),
  }
  action step = any {
    resume, route_lost, probe_ok, probe_miss, reconnect,
    roster_start, roster_finish, late_roster_finish, roster_failed, dispose, dispatch,
  }
  val inv_current_roster_before_dispatch = not(s.unsafe_dispatch)
  val inv_existing_work_survives = s.peer_live and s.work_running
  val inv_domain = all {
    Set("ready", "probing", "down", "disposed").contains(s.phase),
    s.epoch >= 0, s.epoch <= 2,
    s.roster_epoch >= 0, s.roster_epoch <= s.epoch,
    s.read_epoch >= 0, s.read_epoch <= s.epoch,
  }

  run visible_native_resume_blocks_new_work = {
    init.then(resume).expect(s.phase == "probing" and s.cached_online)
      .then(dispatch.fail())
  }
  run pong_does_not_certify_the_machine_roster = {
    init.then(resume).then(probe_ok).then(dispatch.fail())
  }
  run fresh_online_roster_admits_once = {
    init.then(resume).then(probe_ok).then(roster_start).then(roster_finish)
      .then(dispatch).expect(s.sent and not(s.unsafe_dispatch))
      .then(dispatch.fail())
  }
  run fresh_offline_roster_rejects_new_work = {
    init.then(route_lost).then(resume).then(probe_ok).then(roster_start)
      .then(roster_finish).then(dispatch.fail())
  }
  run late_roster_cannot_certify_the_next_resume = {
    init.then(resume).then(probe_ok).then(roster_start).then(resume)
      .then(probe_ok).then(late_roster_finish)
      .expect(s.epoch == 2 and s.roster_epoch == 0)
      .then(dispatch.fail())
  }
  run late_online_response_cannot_overwrite_new_offline_roster = {
    init.then(resume).then(probe_ok).then(roster_start).then(resume)
      .then(probe_ok).then(route_lost).then(roster_start).then(roster_finish)
      .then(late_roster_finish)
      .expect(s.roster_epoch == 2 and not(s.cached_online))
      .then(dispatch.fail())
  }
  run failed_read_can_be_retried_without_replaying_a_write = {
    init.then(resume).then(probe_ok).then(roster_start).then(roster_failed)
      .then(roster_start).then(roster_finish).then(dispatch)
      .expect(s.sent and not(s.unsafe_dispatch))
  }
  run disposal_fences_late_roster_and_new_work = {
    init.then(roster_start).then(dispose).then(late_roster_finish).then(dispatch.fail())
  }
  run recovery_preserves_authorized_peers_and_running_work = {
    init.then(resume).then(probe_miss).then(reconnect)
      .expect(s.peer_live and s.work_running and s.roster_epoch != s.epoch)
  }
}
