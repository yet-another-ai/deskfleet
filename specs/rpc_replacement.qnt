// Two RPCs, two daemon socket identities on one API node, and one remote caller.
// The model follows a successful route claim. Inbox loss and node failure have
// their own deadlines and are outside this replacement.
module rpc_replacement {
  pure val request_ids = Set("r1", "r2")
  pure val connections = Set("old", "new")
  pure val callers = Set("local", "remote")

  type Request = {
    caller: str,
    connection: str,
    phase: str,
    replied_by: str,
    reply_route: str,
  }

  type State = {
    socket: str,
    route: str,
    published_new: bool,
    old_closed: bool,
    requests: str -> Request,
  }
  var s: State

  pure val idle: Request = {
    caller: "", connection: "", phase: "idle", replied_by: "", reply_route: "",
  }

  action init = s' = {
    socket: "old", route: "old", published_new: false, old_closed: false,
    requests: Map("r1" -> idle, "r2" -> idle),
  }

  action select_as(id: str, caller: str): bool = all {
    s.route != "",
    s.requests.get(id).phase == "idle",
    s' = s.with("requests", s.requests.set(id, idle.with("caller", caller)
      .with("connection", s.route).with("phase", "selected"))),
  }

  // A request can select the old route, then acquire the registration gate
  // only after the replacement has published the new route.
  action admit_as(id: str): bool = {
    val request = s.requests.get(id)
    all {
      s.socket == s.route,
      request.phase == "selected",
      s' = s.with("requests", s.requests.set(id, request.with("phase",
        if (request.connection == s.socket) "pending" else "machine_offline"))),
    }
  }

  pure def retire(request: Request, displaced: str): Request =
    if (request.phase == "pending" and request.connection == displaced)
      request.with("phase", if (request.caller == "local") "machine_offline" else "forwarding_offline")
    else request

  action replace_socket = all {
    s.socket == "old",
    s' = s.with("socket", "new").with("requests", Map(
      "r1" -> retire(s.requests.get("r1"), s.socket),
      "r2" -> retire(s.requests.get("r2"), s.socket))),
  }

  action publish_route = all {
    s.socket == "new", not(s.published_new),
    s' = s.with("route", "new").with("published_new", true),
  }

  // The forwarding entry was removed with the socket swap. Publishing that
  // error to its caller is a separate action after the route claim.
  action forward_offline_as(id: str): bool = {
    val request = s.requests.get(id)
    all {
      s.route == "new", request.phase == "forwarding_offline",
      s' = s.with("requests", s.requests.set(id, request.with("phase", "machine_offline"))),
    }
  }

  action reply_as(id: str, sender: str): bool = {
    val request = s.requests.get(id)
    all {
      request.phase != "idle", request.phase != "selected",
      s' = if (request.phase == "pending" and sender == s.socket and sender == request.connection)
        s.with("requests", s.requests.set(id, request.with("phase", "ok")
          .with("replied_by", sender).with("reply_route", s.route)))
      else s,
    }
  }

  // The old socket can release its database route before the new claim wins.
  // It can only delete its own row, even if it finishes after publication.
  action cleanup_previous = all {
    s.socket == "new", not(s.old_closed),
    s' = s.with("old_closed", true).with("route", if (s.route == "old") "" else s.route),
  }

  action select_rpc = {
    nondet id = oneOf(request_ids)
    nondet caller = oneOf(callers)
    select_as(id, caller)
  }
  action admit_rpc = {
    nondet id = oneOf(request_ids)
    admit_as(id)
  }
  action forward_offline = {
    nondet id = oneOf(request_ids)
    forward_offline_as(id)
  }
  action reply = {
    nondet id = oneOf(request_ids)
    nondet sender = oneOf(connections)
    reply_as(id, sender)
  }

  action step = any {
    select_rpc, admit_rpc, replace_socket, publish_route, forward_offline, reply, cleanup_previous,
  }

  val inv_pending_on_current_socket = request_ids.forall(id => {
    val request = s.requests.get(id)
    request.phase != "pending" or (request.connection == s.socket and request.connection == s.route)
  })

  val inv_reply_matches_admission = request_ids.forall(id => {
    val request = s.requests.get(id)
    request.phase != "ok" or
      (request.replied_by == request.connection and request.reply_route == request.connection)
  })

  val inv_forwarded_failure_belongs_to_displaced_socket = request_ids.forall(id => {
    val request = s.requests.get(id)
    request.phase != "forwarding_offline" or
      (request.caller == "remote" and request.connection != s.socket)
  })

  val inv_old_close_keeps_new_route = not(s.published_new) or (s.socket == "new" and s.route == "new")

  run replacement_retires_local_and_forwarded_rpcs = {
    init.then(select_as("r1", "local")).then(admit_as("r1"))
      .then(select_as("r2", "remote")).then(admit_as("r2"))
      .then(replace_socket)
      .expect(s.requests.get("r1").phase == "machine_offline" and s.requests.get("r2").phase == "forwarding_offline")
      .then(reply_as("r2", "old"))
      .then(publish_route).then(forward_offline_as("r2"))
      .expect(s.requests.get("r2").phase == "machine_offline" and s.route == "new")
  }

  run stale_route_admission_rejects_when_gate_opens = {
    init.then(select_as("r1", "local")).then(replace_socket)
      .then(select_as("r2", "remote"))
      .then(publish_route).then(admit_as("r1")).then(admit_as("r2"))
      .expect(s.requests.get("r1").phase == "machine_offline" and s.requests.get("r2").phase == "machine_offline")
  }

  run registration_gate_blocks_admission_during_replacement = {
    init.then(select_as("r1", "local")).then(replace_socket)
      .then(admit_as("r1").fail())
  }

  run late_old_replies_and_cleanup_preserve_new_rpc = {
    init.then(select_as("r1", "local")).then(admit_as("r1"))
      .then(replace_socket).then(publish_route)
      .then(select_as("r2", "remote")).then(admit_as("r2"))
      .then(reply_as("r1", "old")).then(reply_as("r2", "old")).then(cleanup_previous)
      .expect(s.requests.get("r1").phase == "machine_offline" and s.requests.get("r2").phase == "pending")
      .then(reply_as("r2", "new"))
      .expect(s.requests.get("r2").phase == "ok" and s.route == "new")
  }

  run old_cleanup_can_unpublish_displaced_route_before_claim = {
    init.then(select_as("r1", "local")).then(replace_socket).then(cleanup_previous)
      .expect(s.socket == "new" and s.route == "")
      .then(publish_route).then(admit_as("r1"))
      .then(select_as("r2", "remote")).then(admit_as("r2")).then(reply_as("r2", "new"))
      .expect(s.requests.get("r1").phase == "machine_offline" and s.requests.get("r2").phase == "ok")
  }

  run no_route_can_be_selected_in_the_gap = {
    init.then(replace_socket).then(cleanup_previous)
      .then(select_as("r1", "remote").fail())
  }

  run completed_rpc_survives_replacement = {
    init.then(select_as("r1", "local")).then(admit_as("r1")).then(reply_as("r1", "old"))
      .then(replace_socket).then(publish_route).then(cleanup_previous)
      .expect(s.requests.get("r1").phase == "ok" and s.requests.get("r1").replied_by == "old")
  }
}
