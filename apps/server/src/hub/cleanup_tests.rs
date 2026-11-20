//! Socket shutdown may clear local routing before its WebSocket cleanup runs.
use super::*;
use serde_json::json;

#[tokio::test]
async fn same_node_replacement_retires_old_rpc_before_socket_cleanup() {
    let hub = Hub::default();
    let (old_send, mut old_messages) = mpsc::channel(1);
    let (old_shutdown, old_stopped) = watch::channel(None);
    hub.add_daemon(
        "registration",
        "team",
        "machine",
        "old",
        old_send,
        old_shutdown,
    )
    .await
    .unwrap();

    let old_request = hub.request("registration", "terminalList", json!({}), None);
    tokio::pin!(old_request);
    assert!(futures_util::poll!(&mut old_request).is_pending());
    let Ok(ControlMessage::Request { id: old_id, .. }) = old_messages.try_recv() else {
        panic!("old socket must receive terminalList");
    };

    let (new_send, mut new_messages) = mpsc::channel(1);
    let (new_shutdown, new_stopped) = watch::channel(None);
    hub.add_daemon(
        "registration",
        "team",
        "machine",
        "new",
        new_send,
        new_shutdown,
    )
    .await
    .unwrap();
    assert_eq!(*old_stopped.borrow(), Some(1012));
    let error = tokio::time::timeout(Duration::from_secs(1), old_request)
        .await
        .expect("replacement releases the RPC before old socket cleanup")
        .unwrap_err();
    assert_eq!(error.status.as_u16(), 503);
    assert_eq!(error.code, "machine_offline");

    let new_request = hub.request("registration", "terminalList", json!({}), None);
    tokio::pin!(new_request);
    assert!(futures_util::poll!(&mut new_request).is_pending());
    let Ok(ControlMessage::Request { id: new_id, .. }) = new_messages.try_recv() else {
        panic!("replacement socket must receive terminalList");
    };
    hub.response("registration", "old", &old_id, Ok(json!([])))
        .await;
    hub.response("registration", "old", &new_id, Ok(json!("stale")))
        .await;
    assert!(!hub.remove_daemon("registration", "old").await);
    assert!(new_stopped.borrow().is_none());
    assert!(futures_util::poll!(&mut new_request).is_pending());
    hub.response("registration", "new", &new_id, Ok(json!([])))
        .await;
    assert_eq!(new_request.await.unwrap(), json!([]));
}

#[tokio::test]
async fn request_deadline_bounds_delivery_and_response_and_retires_pending_rpc() {
    for block_delivery in [false, true] {
        let hub = Hub::default();
        let (send, mut messages) = mpsc::channel(8);
        let (shutdown, _stopped) = watch::channel(None);
        hub.add_daemon("registration", "team", "machine", "socket", send, shutdown)
            .await
            .unwrap();
        let _delivery_gate = if block_delivery {
            Some(hub.registration.lock().await)
        } else {
            None
        };
        let error = hub
            .request_with_timeout(
                "registration",
                "remoteMcpDiscover",
                json!({}),
                None,
                Duration::from_millis(25),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "daemon_timeout");
        assert!(hub.inner.lock().await.pending.is_empty());
        assert_eq!(messages.try_recv().is_ok(), !block_delivery);
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_socket_cleanup_releases_route_after_local_failure() {
    let store =
        ControlStore::connect(&std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"))
            .await
            .unwrap();
    let user = store
        .verified_user(
            &format!("route-cleanup-{}@fixture.test", uuid::Uuid::new_v4()),
            "Owner",
        )
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Cleanup").await.unwrap();
    let (machine, _) = store
        .enroll(
            &user.id,
            &team.id,
            "Machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
            &deskfleet_control_store::secret(),
        )
        .await
        .unwrap();
    let (hub, router) = Hub::connect(store.clone()).await.unwrap();
    let (send, _messages) = mpsc::channel(8);
    let (shutdown, stopped) = watch::channel(None);
    hub.add_daemon(
        &machine.id,
        &machine.team_id,
        &machine.machine_id,
        "socket",
        send,
        shutdown,
    )
    .await
    .unwrap();

    hub.fail_local().await;
    assert_eq!(*stopped.borrow(), Some(1012));
    assert!(!hub.is_current(&machine.id, "socket").await);
    assert!(store.machine_route(&machine.id).await.unwrap().is_some());

    assert!(hub.remove_daemon(&machine.id, "socket").await);
    assert!(store.machine_route(&machine.id).await.unwrap().is_none());
    assert!(!hub.remove_daemon(&machine.id, "socket").await);
    drop(router);
    store.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_unhealthy_cluster_rejects_client_without_storing_socket() {
    let store =
        ControlStore::connect(&std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"))
            .await
            .unwrap();
    let (hub, router) = Hub::connect(store.clone()).await.unwrap();
    hub.cluster
        .as_ref()
        .expect("clustered hub")
        .mark_unhealthy();
    let (send, mut messages) = mpsc::channel(8);
    let (shutdown, stopped) = watch::channel(None);
    assert!(
        hub.add_client("login", "user", "connection", send, shutdown)
            .await
            .is_err()
    );
    // Match the daemon path: refuse registration without signaling Ready via a
    // stored sender, and leave close-code handling to the websocket caller.
    assert!(stopped.borrow().is_none());
    assert!(messages.try_recv().is_err());
    drop(router);
    store.close().await.unwrap();
}
