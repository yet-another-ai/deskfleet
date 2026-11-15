use super::*;
use serde_json::json;

fn catalog(team: &str, machine: &str, session: Option<&str>) -> ControlMessage {
    ControlMessage::CatalogChanged {
        team_id: team.into(),
        machine_id: machine.into(),
        session_id: session.map(str::to_owned),
    }
}

fn request(id: &str) -> ControlMessage {
    ControlMessage::Request {
        id: id.into(),
        method: "test".into(),
        params: json!({}),
        actor: None,
    }
}

fn candidate(index: usize) -> ControlMessage {
    ControlMessage::PeerEvent {
        peer_id: "peer".into(),
        event: json!({ "kind": "iceCandidate", "candidate": { "candidate": index.to_string() } }),
    }
}

fn snapshot(id: &str) -> ControlMessage {
    ControlMessage::ReconcilePeers { peers: vec![serde_json::from_value(json!({
        "peerId": id, "serverId": "server", "teamId": "team",
        "actor": { "kind": "user", "userId": "user", "deviceId": "device" },
        "targetMachine": { "id": "machine", "originId": "origin", "localMachineId": "1" },
        "transport": "webrtc", "purpose": "agent", "actions": [], "issuedAt": "now", "expiresAt": "later"
    })).unwrap()] }
}

async fn message(receiver: &mut Receiver) -> ControlMessage {
    match receiver.recv().await.expect("sender stays open") {
        Outbound::Message(message) => *message,
        Outbound::Reconcile | Outbound::Reconnect => panic!("expected a wire message"),
    }
}

#[tokio::test]
async fn high_rate_history_hints_coalesce_without_occupying_command_capacity() {
    let (send, mut receive) = channel(2);
    for _ in 0..10_000 {
        send.try_send(catalog("team", "machine", Some("session")))
            .unwrap();
    }
    send.try_send(request("first")).unwrap();
    send.try_send(request("second")).unwrap();
    assert_eq!(send.try_send(request("busy")), Err(SendError::Full));
    assert!(
        matches!(message(&mut receive).await, ControlMessage::Request { id, .. } if id == "first")
    );
    assert!(
        matches!(message(&mut receive).await, ControlMessage::Request { id, .. } if id == "second")
    );
    assert!(
        matches!(message(&mut receive).await, ControlMessage::CatalogChanged { session_id: Some(session), .. } if session == "session")
    );
    assert_eq!(send.0.state.lock().unwrap().hints.len(), 0);
}

#[tokio::test]
async fn catalog_coalescing_broadens_sessions_and_keeps_team_machine_scope() {
    let (send, mut receive) = channel(4);
    send.try_send(catalog("first", "machine", Some("one")))
        .unwrap();
    send.try_send(catalog("first", "machine", Some("two")))
        .unwrap();
    send.try_send(catalog("first", "machine", Some("three")))
        .unwrap();
    send.try_send(catalog("second", "machine", Some("one")))
        .unwrap();
    send.try_send(catalog("first", "other", Some("one")))
        .unwrap();
    assert!(
        matches!(message(&mut receive).await, ControlMessage::CatalogChanged { team_id, machine_id, session_id: None } if team_id == "first" && machine_id == "machine")
    );
    assert!(
        matches!(message(&mut receive).await, ControlMessage::CatalogChanged { team_id, session_id: Some(_), .. } if team_id == "second")
    );
    assert!(
        matches!(message(&mut receive).await, ControlMessage::CatalogChanged { machine_id, .. } if machine_id == "other")
    );
}

#[tokio::test]
async fn overflowing_distinct_hints_retires_the_queue_and_releases_critical_waiters() {
    let (send, mut receive) = channel(2);
    send.try_send(request("first")).unwrap();
    send.try_send(request("second")).unwrap();
    send.try_send(candidate(0)).unwrap();
    let pending = send.send(request("waiting"));
    tokio::pin!(pending);
    assert!(futures_util::poll!(&mut pending).is_pending());
    for machine in 0..3 {
        send.try_send(catalog("team", &machine.to_string(), None))
            .unwrap();
    }
    assert_eq!(pending.await, Err(SendError::Closed));
    assert_eq!(send.try_send(request("late")), Err(SendError::Closed));
    assert_eq!(send.try_send(candidate(1)), Err(SendError::Closed));
    send.request_reconciliation();
    {
        let state = send.0.state.lock().unwrap();
        assert!(state.commands.is_empty());
        assert!(state.hints.is_empty());
        assert!(state.candidates.is_empty());
    }
    assert!(matches!(receive.recv().await, Some(Outbound::Reconnect)));
    assert!(receive.recv().await.is_none());
    assert_eq!(
        send.try_send(catalog("team", "later", None)),
        Err(SendError::Closed)
    );
}

#[tokio::test]
async fn overflowing_ice_candidates_never_waits_for_or_consumes_critical_capacity() {
    let (send, mut receive) = channel(128);
    for index in 0..10_000 {
        let sending = send.send(candidate(index));
        tokio::pin!(sending);
        assert!(matches!(
            futures_util::poll!(&mut sending),
            std::task::Poll::Ready(Ok(()))
        ));
    }
    assert_eq!(send.0.state.lock().unwrap().candidates.len(), 128);
    send.try_send(request("rpc")).unwrap();
    send.try_send(ControlMessage::PeerEvent {
        peer_id: "peer".into(),
        event: json!({ "kind": "stateChanged", "state": "closed" }),
    })
    .unwrap();
    send.try_send(ControlMessage::PeerRevoked {
        peer_id: "peer".into(),
        reason: "revoked".into(),
    })
    .unwrap();
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::Request { .. }
    ));
    assert!(
        matches!(message(&mut receive).await, ControlMessage::PeerEvent { event, .. } if event["kind"] == "stateChanged")
    );
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::PeerRevoked { .. }
    ));
    for index in 0..128 {
        let expected = index.to_string();
        assert!(
            matches!(message(&mut receive).await, ControlMessage::PeerEvent { event, .. } if event["candidate"]["candidate"].as_str() == Some(expected.as_str()))
        );
    }
    assert!(matches!(
        receive.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn sustained_commands_give_both_candidates_and_refreshes_bounded_progress() {
    let (send, mut receive) = channel(1);
    send.try_send(candidate(0)).unwrap();
    send.try_send(catalog("team", "machine", None)).unwrap();
    for (hint, commands) in [(true, 16), (false, 15)] {
        for index in 0..commands {
            send.try_send(request(&index.to_string())).unwrap();
            assert!(matches!(
                message(&mut receive).await,
                ControlMessage::Request { .. }
            ));
        }
        send.try_send(request("after-background")).unwrap();
        let delivered = message(&mut receive).await;
        assert_eq!(is_hint(&delivered), hint);
        assert_eq!(is_candidate(&delivered), !hint);
        assert!(matches!(
            message(&mut receive).await,
            ControlMessage::Request { .. }
        ));
    }
}

#[tokio::test]
async fn pending_presence_keeps_only_the_latest_state() {
    let (send, mut receive) = channel(1);
    for online in [true, false, true] {
        send.try_send(ControlMessage::Presence {
            team_id: "team".into(),
            machine_id: "machine".into(),
            online,
        })
        .unwrap();
    }
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::Presence { online: true, .. }
    ));
}

#[tokio::test]
async fn sustained_commands_do_not_starve_refreshes() {
    let (send, mut receive) = channel(1);
    send.try_send(catalog("team", "machine", None)).unwrap();
    for n in 0..16 {
        send.try_send(request(&n.to_string())).unwrap();
        assert!(matches!(
            message(&mut receive).await,
            ControlMessage::Request { .. }
        ));
    }
    send.try_send(request("still-busy")).unwrap();
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::CatalogChanged { .. }
    ));
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::Request { .. }
    ));
}

#[tokio::test]
async fn reconciliation_uses_reserved_capacity_and_follows_intervening_offers() {
    let (send, mut receive) = channel(1);
    send.try_send(snapshot("old")).unwrap();
    send.try_send(request("offer")).unwrap();
    send.request_reconciliation();
    send.try_send(snapshot("discarded")).unwrap();
    assert!(
        matches!(message(&mut receive).await, ControlMessage::ReconcilePeers { peers } if peers[0].peer_id == "old")
    );
    assert!(matches!(receive.recv().await, Some(Outbound::Reconcile)));
    send.try_send(snapshot("fresh")).unwrap();
    assert_eq!(send.0.state.lock().unwrap().commands.len(), 2);
    assert!(
        matches!(message(&mut receive).await, ControlMessage::Request { id, .. } if id == "offer")
    );
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::ReconcilePeers { peers } if peers[0].peer_id == "fresh"
    ));
}

#[tokio::test]
async fn repeated_reconciliation_cannot_move_a_snapshot_behind_new_requests() {
    let (send, mut receive) = channel(1);
    send.try_send(request("first")).unwrap();
    send.try_send(snapshot("oldest")).unwrap();
    let mut delivered = false;
    for n in 0..64 {
        send.request_reconciliation();
        send.try_send(snapshot("discarded")).unwrap();
        match message(&mut receive).await {
            ControlMessage::ReconcilePeers { peers } => {
                assert_eq!(peers[0].peer_id, "oldest");
                assert_eq!(
                    n, 1,
                    "only the request already ahead may precede this snapshot"
                );
                delivered = true;
                break;
            }
            ControlMessage::Request { .. } => send.try_send(request("next")).unwrap(),
            _ => panic!("expected FIFO command or snapshot"),
        }
    }
    assert!(
        delivered,
        "a revoked grant must not wait behind continuously arriving requests"
    );
    // The discarded snapshot is not replayed. Re-read current grants after the
    // old snapshot, then append them after the intervening request.
    assert!(matches!(receive.recv().await, Some(Outbound::Reconcile)));
    send.try_send(snapshot("fresh")).unwrap();
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::Request { .. }
    ));
    assert!(
        matches!(message(&mut receive).await, ControlMessage::ReconcilePeers { peers } if peers[0].peer_id == "fresh")
    );
}

#[tokio::test]
async fn critical_delivery_waits_for_space_and_receiver_close_releases_waiters() {
    let (send, mut receive) = channel(1);
    send.try_send(request("first")).unwrap();
    let pending = send.send(request("second"));
    tokio::pin!(pending);
    assert!(futures_util::poll!(&mut pending).is_pending());
    assert!(
        matches!(message(&mut receive).await, ControlMessage::Request { id, .. } if id == "first")
    );
    pending.await.unwrap();
    let waiting = send.send(request("third"));
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());
    drop(receive);
    assert_eq!(waiting.await, Err(SendError::Closed));
}

#[tokio::test]
async fn final_sender_drop_finishes_after_queued_messages() {
    let (send, mut receive) = channel(1);
    send.try_send(request("last")).unwrap();
    let other = send.clone();
    drop(send);
    assert!(matches!(
        message(&mut receive).await,
        ControlMessage::Request { .. }
    ));
    drop(other);
    assert!(receive.recv().await.is_none());
}
