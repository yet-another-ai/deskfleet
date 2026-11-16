// Grant authorization lifecycle for one client, one daemon, and two peers.
// Decisions live in agents/docs/webrtc-security.md. This module checks their
// interleavings; agents/docs/control-plane-verification.md owns the runs below.
module grant_lifecycle {
  pure val peer_ids = Set("p1", "p2")
  pure val transports = Set("local", "webrtc")
  pure val actors = Set("u1", "u2")
  pure val offers = Set("o1", "o2")

  type Grant = {
    phase: str,
    actor: str,
    transport: str,
    fingerprint: str,
    offer: str,
    answer: str,
    reservation_open: bool,
    activated: bool,
    expired: bool,
    revoked: bool,
    sealed: bool,
    claims: int,
    ice_seen: bool,
    accepted: bool,
    accepted_work: bool,
    grace: bool,
    expiry: int,
    expiry_cap: int,
    inbox_lost: bool,
  }

  /// Written by reservation and the first offer or answer. Every other action keeps it.
  type Binding = {
    actor: str,
    transport: str,
    offer: str,
    answer: str,
    fingerprint: str,
    identity_latched: bool,
    fingerprint_latched: bool,
  }

  var grant: str -> Grant
  var binding: str -> Binding
  var signaling: bool
  var outage: Set[str]

  pure val blank: Grant = {
    phase: "absent",
    actor: "",
    transport: "",
    fingerprint: "",
    offer: "",
    answer: "",
    reservation_open: false,
    activated: false,
    expired: false,
    revoked: false,
    sealed: false,
    claims: 0,
    ice_seen: false,
    accepted: false,
    accepted_work: false,
    grace: false,
    expiry: 0,
    expiry_cap: 0,
    inbox_lost: false,
  }

  pure val unbound: Binding = {
    actor: "",
    transport: "",
    offer: "",
    answer: "",
    fingerprint: "",
    identity_latched: false,
    fingerprint_latched: false,
  }

  pure def reserve(transport: str, actor: str): Grant =
    blank
      .with("phase", "reserved")
      .with("actor", actor)
      .with("transport", transport)
      .with("reservation_open", true)

  pure def bind_identity(actor: str, transport: str): Binding =
    unbound
      .with("actor", actor)
      .with("transport", transport)
      .with("identity_latched", true)

  pure def close_grant(g: Grant): Grant =
    g.with("phase", "closed")
      .with("sealed", true)
      .with("reservation_open", false)
      .with("grace", false)

  pure def negotiating(g: Grant): bool =
    g.phase == "reserved" or g.phase == "bound" or g.phase == "answered" or g.phase == "established"

  action init: bool = all {
    grant' = Map("p1" -> blank, "p2" -> blank),
    binding' = Map("p1" -> unbound, "p2" -> unbound),
    signaling' = true,
    outage' = Set(),
  }

  action request_with(id: str, transport: str, actor: str): bool = all {
    signaling,
    grant.get(id).phase == "absent",
    grant' = grant.set(id, reserve(transport, actor)),
    binding' = binding.set(id, bind_identity(actor, transport)),
    signaling' = signaling,
    outage' = outage,
  }

  action request_as(id: str, transport: str): bool = request_with(id, transport, "u1")

  action request_grant: bool = {
    nondet id = oneOf(peer_ids)
    nondet transport = oneOf(transports)
    nondet actor = oneOf(actors)
    request_with(id, transport, actor)
  }

  action activate_as(id: str): bool = all {
    grant.get(id).reservation_open,
    grant.get(id).phase == "reserved",
    not(grant.get(id).activated),
    not(grant.get(id).sealed),
    grant' = grant.set(id, grant.get(id)
      .with("reservation_open", false)
      .with("activated", true)
      .with("expiry", 1)
      .with("expiry_cap", 1)),
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action activate: bool = {
    nondet id = oneOf(peer_ids)
    activate_as(id)
  }

  action lapse_as(id: str): bool = all {
    grant.get(id).reservation_open,
    not(grant.get(id).activated),
    grant.get(id).phase == "reserved",
    grant' = grant.set(id, close_grant(grant.get(id))),
    binding' = binding,
    signaling' = signaling,
    outage' = outage.filter(x => x != id),
  }

  action reservation_due: bool = {
    nondet id = oneOf(peer_ids)
    lapse_as(id)
  }

  /// A crash before activation consumes the reservation the same way the lease does.
  action crash_as(id: str): bool = lapse_as(id)

  action crash_before_activate: bool = {
    nondet id = oneOf(peer_ids)
    crash_as(id)
  }

  action submit_offer_as(id: str, offer: str): bool = all {
    signaling,
    grant.get(id).transport == "webrtc",
    grant.get(id).activated,
    grant.get(id).phase == "reserved",
    not(grant.get(id).inbox_lost),
    not(grant.get(id).sealed),
    not(binding.get(id).fingerprint_latched),
    grant' = grant.set(id, grant.get(id)
      .with("phase", "bound")
      .with("offer", offer)
      .with("fingerprint", offer)),
    binding' = binding.set(id, binding.get(id)
      .with("offer", offer)
      .with("fingerprint", offer)
      .with("fingerprint_latched", true)),
    signaling' = signaling,
    outage' = outage,
  }

  action submit_offer: bool = {
    nondet id = oneOf(peer_ids)
    nondet offer = oneOf(offers)
    submit_offer_as(id, offer)
  }

  action submit_answer_as(id: str): bool = all {
    signaling,
    grant.get(id).phase == "bound",
    grant.get(id).transport == "webrtc",
    not(grant.get(id).inbox_lost),
    not(grant.get(id).sealed),
    binding.get(id).answer == "",
    grant' = grant.set(id, grant.get(id).with("phase", "answered").with("answer", "a1")),
    binding' = binding.set(id, binding.get(id).with("answer", "a1")),
    signaling' = signaling,
    outage' = outage,
  }

  action submit_answer: bool = {
    nondet id = oneOf(peer_ids)
    submit_answer_as(id)
  }

  action establish_as(id: str): bool = all {
    grant.get(id).phase == "answered",
    not(grant.get(id).inbox_lost),
    not(grant.get(id).sealed),
    grant' = grant.set(id, grant.get(id).with("phase", "established")),
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action establish: bool = {
    nondet id = oneOf(peer_ids)
    establish_as(id)
  }

  action claim_as(id: str): bool = all {
    grant.get(id).transport == "local",
    grant.get(id).activated,
    grant.get(id).claims == 0,
    not(grant.get(id).sealed),
    not(grant.get(id).expired),
    grant.get(id).phase == "reserved" or grant.get(id).phase == "established",
    grant' = grant.set(id, grant.get(id).with("claims", 1).with("phase", "established")),
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action claim_local: bool = {
    nondet id = oneOf(peer_ids)
    claim_as(id)
  }

  action trickle_as(id: str): bool = all {
    signaling,
    grant.get(id).transport == "webrtc",
    grant.get(id).activated,
    not(grant.get(id).sealed),
    not(grant.get(id).ice_seen),
    negotiating(grant.get(id)),
    grant' = grant.set(id, grant.get(id).with("ice_seen", true)),
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action trickle_ice: bool = {
    nondet id = oneOf(peer_ids)
    trickle_as(id)
  }

  action relay_as(id: str): bool = all {
    grant.get(id).transport == "webrtc",
    grant.get(id).expiry_cap == 1,
    grant.get(id).phase == "established",
    not(grant.get(id).sealed),
    grant' = grant,
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action relay_refresh: bool = {
    nondet id = oneOf(peer_ids)
    relay_as(id)
  }

  action signaling_down: bool = all {
    signaling,
    signaling' = false,
    grant' = grant,
    binding' = binding,
    outage' = peer_ids.filter(id => grant.get(id).phase == "established" and not(grant.get(id).expired)),
  }

  action signaling_up: bool = all {
    not(signaling),
    signaling' = true,
    grant' = grant,
    binding' = binding,
    outage' = Set(),
  }

  /// The notice is applied when the control connection can deliver it.
  action revoke_as(id: str): bool = all {
    signaling,
    grant.get(id).activated,
    not(grant.get(id).sealed),
    grant' = grant.set(id, close_grant(grant.get(id)).with("revoked", true)),
    binding' = binding,
    signaling' = signaling,
    outage' = outage.filter(x => x != id),
  }

  action revoke: bool = {
    nondet id = oneOf(peer_ids)
    revoke_as(id)
  }

  action authorization_due_as(id: str): bool = all {
    grant.get(id).activated,
    not(grant.get(id).sealed),
    grant' = grant.set(id, close_grant(grant.get(id)).with("expired", true)),
    binding' = binding,
    signaling' = signaling,
    outage' = outage.filter(x => x != id),
  }

  action authorization_due: bool = {
    nondet id = oneOf(peer_ids)
    authorization_due_as(id)
  }

  action setup_due_as(id: str): bool = all {
    grant.get(id).transport == "webrtc",
    grant.get(id).activated,
    not(grant.get(id).sealed),
    grant.get(id).phase == "reserved" or grant.get(id).phase == "bound" or grant.get(id).phase == "answered",
    grant' = grant.set(id, close_grant(grant.get(id))),
    binding' = binding,
    signaling' = signaling,
    outage' = outage.filter(x => x != id),
  }

  action setup_due: bool = {
    nondet id = oneOf(peer_ids)
    setup_due_as(id)
  }

  action disconnected_grace_as(id: str): bool = all {
    grant.get(id).phase == "established",
    not(grant.get(id).grace),
    not(grant.get(id).sealed),
    grant' = grant.set(id, grant.get(id).with("grace", true)),
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action disconnected_grace: bool = {
    nondet id = oneOf(peer_ids)
    disconnected_grace_as(id)
  }

  action recovery_due_as(id: str): bool = all {
    grant.get(id).grace,
    grant.get(id).phase == "established",
    grant' = grant.set(id, close_grant(grant.get(id))),
    binding' = binding,
    signaling' = signaling,
    outage' = outage.filter(x => x != id),
  }

  action recovery_due: bool = {
    nondet id = oneOf(peer_ids)
    recovery_due_as(id)
  }

  action failed_immediate_as(id: str): bool = all {
    grant.get(id).phase == "established",
    not(grant.get(id).sealed),
    grant' = grant.set(id, close_grant(grant.get(id))),
    binding' = binding,
    signaling' = signaling,
    outage' = outage.filter(x => x != id),
  }

  action failed_immediate: bool = {
    nondet id = oneOf(peer_ids)
    failed_immediate_as(id)
  }

  action resume_page: bool = {
    nondet old_id = oneOf(peer_ids)
    nondet new_id = oneOf(peer_ids)
    nondet transport = oneOf(transports)
    all {
      signaling,
      old_id != new_id,
      grant.get(old_id).sealed,
      grant.get(new_id).phase == "absent",
      grant' = grant.set(new_id, reserve(transport, "u1")),
      binding' = binding.set(new_id, bind_identity("u1", transport)),
      signaling' = signaling,
      outage' = outage,
    }
  }

  action accept_as(id: str): bool = all {
    grant.get(id).phase == "established",
    not(grant.get(id).sealed),
    not(grant.get(id).accepted),
    grant' = grant.set(id, grant.get(id).with("accepted", true).with("accepted_work", true)),
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action accept_work: bool = {
    nondet id = oneOf(peer_ids)
    accept_as(id)
  }

  action drop_inbox_as(id: str): bool = all {
    grant.get(id).phase == "bound" or grant.get(id).phase == "answered",
    not(grant.get(id).inbox_lost),
    grant' = grant.set(id, grant.get(id).with("inbox_lost", true)),
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action drop_inbox: bool = {
    nondet id = oneOf(peer_ids)
    drop_inbox_as(id)
  }

  action duplicate_as(id: str): bool = all {
    binding.get(id).fingerprint_latched,
    binding.get(id).offer != "",
    grant' = grant,
    binding' = binding,
    signaling' = signaling,
    outage' = outage,
  }

  action duplicate_delivery: bool = {
    nondet id = oneOf(peer_ids)
    duplicate_as(id)
  }

  action step: bool = any {
    request_grant,
    activate,
    reservation_due,
    crash_before_activate,
    submit_offer,
    submit_answer,
    establish,
    claim_local,
    trickle_ice,
    relay_refresh,
    signaling_down,
    signaling_up,
    revoke,
    authorization_due,
    setup_due,
    disconnected_grace,
    recovery_due,
    failed_immediate,
    resume_page,
    accept_work,
    drop_inbox,
    duplicate_delivery,
  }

  pure def binding_ok(g: Grant, frozen: Binding): bool =
    (not(frozen.identity_latched) or (g.actor == frozen.actor and g.transport == frozen.transport)) and
    g.answer == frozen.answer and
    (not(frozen.fingerprint_latched) or (g.fingerprint == frozen.fingerprint and g.offer == frozen.offer))

  val inv_binding_stable: bool = peer_ids.forall(id => binding_ok(grant.get(id), binding.get(id)))

  val inv_outage_keeps_established: bool = outage.forall(id =>
    grant.get(id).phase == "established" and not(grant.get(id).expired))

  val inv_sealed_stays_closed: bool = peer_ids.forall(id =>
    not(grant.get(id).sealed) or grant.get(id).phase == "closed")

  val inv_reservation_required: bool = peer_ids.forall(id =>
    not(grant.get(id).reservation_open) or (
      grant.get(id).phase == "reserved" and not(grant.get(id).activated) and not(grant.get(id).sealed)))

  val inv_single_claim: bool = peer_ids.forall(id =>
    grant.get(id).claims >= 0 and grant.get(id).claims <= 1 and
    (grant.get(id).claims == 0 or grant.get(id).transport == "local"))

  val inv_transport_separation: bool = peer_ids.forall(id =>
    (grant.get(id).transport != "local" or (grant.get(id).offer == "" and grant.get(id).fingerprint == "")) and
    (grant.get(id).transport != "webrtc" or grant.get(id).claims == 0))

  val inv_expiry_not_extended: bool = peer_ids.forall(id =>
    grant.get(id).expiry >= 0 and grant.get(id).expiry <= grant.get(id).expiry_cap and grant.get(id).expiry_cap <= 1)

  val inv_accepted_work_survives: bool = peer_ids.forall(id =>
    not(grant.get(id).accepted) or grant.get(id).accepted_work)

  run signaling_loss_keeps_established_peer = {
    init
      .then(request_as("p1", "webrtc"))
      .then(activate_as("p1"))
      .then(submit_offer_as("p1", "o1"))
      .then(submit_answer_as("p1"))
      .then(establish_as("p1"))
      .then(accept_as("p1"))
      .then(signaling_down)
      .expect(not(signaling) and grant.get("p1").phase == "established" and grant.get("p1").accepted_work and outage.contains("p1"))
  }

  run reconnect_does_not_extend_expiry = {
    init
      .then(request_as("p1", "webrtc"))
      .then(activate_as("p1"))
      .then(submit_offer_as("p1", "o1"))
      .then(submit_answer_as("p1"))
      .then(establish_as("p1"))
      .then(signaling_down)
      .then(signaling_up)
      .then(relay_as("p1"))
      .expect(signaling and grant.get("p1").expiry == 1 and grant.get("p1").expiry_cap == 1 and grant.get("p1").phase == "established")
  }

  run changed_offer_keeps_binding = {
    init
      .then(request_as("p1", "webrtc"))
      .then(activate_as("p1"))
      .then(submit_offer_as("p1", "o1"))
      .expect(grant.get("p1").offer == "o1" and binding.get("p1").fingerprint == "o1" and grant.get("p1").fingerprint == "o1" and grant.get("p1").phase == "bound")
      .then(submit_offer_as("p1", "o2").fail())
  }

  run expired_reservation_cannot_activate = {
    init
      .then(request_as("p1", "webrtc"))
      .then(lapse_as("p1"))
      .then(request_as("p2", "local"))
      .then(crash_as("p2"))
      .expect(
        grant.get("p1").sealed and not(grant.get("p1").reservation_open) and grant.get("p1").phase == "closed" and
        grant.get("p2").sealed and not(grant.get("p2").reservation_open))
      .then(activate_as("p1").fail())
  }

  run local_claim_is_single_use = {
    init
      .then(request_as("p1", "local"))
      .then(activate_as("p1"))
      .then(claim_as("p1"))
      .then(revoke_as("p1"))
      .expect(grant.get("p1").claims == 1 and grant.get("p1").sealed and grant.get("p1").phase == "closed")
      .then(claim_as("p1").fail())
  }

  run transports_are_not_interchangeable = {
    init
      .then(request_as("p1", "local"))
      .then(activate_as("p1"))
      .then(request_as("p2", "webrtc"))
      .then(activate_as("p2"))
      .expect(grant.get("p1").offer == "" and grant.get("p1").fingerprint == "" and grant.get("p2").claims == 0)
      .then(any {
        submit_offer_as("p1", "o1"),
        claim_as("p2"),
      }.fail())
  }

  run relay_refresh_keeps_expiry = {
    init
      .then(request_as("p1", "webrtc"))
      .then(activate_as("p1"))
      .then(submit_offer_as("p1", "o1"))
      .then(submit_answer_as("p1"))
      .then(establish_as("p1"))
      .then(relay_as("p1"))
      .expect(grant.get("p1").expiry == 1 and grant.get("p1").expiry_cap == 1 and grant.get("p1").phase == "established")
  }

  run expiry_leaves_accepted_work_running = {
    init
      .then(request_as("p1", "webrtc"))
      .then(activate_as("p1"))
      .then(submit_offer_as("p1", "o1"))
      .then(submit_answer_as("p1"))
      .then(establish_as("p1"))
      .then(accept_as("p1"))
      .then(authorization_due_as("p1"))
      .expect(grant.get("p1").phase == "closed" and grant.get("p1").expired and grant.get("p1").accepted_work and grant.get("p1").sealed)
  }
}
