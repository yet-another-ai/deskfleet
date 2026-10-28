//! Socket shutdown may clear local routing before its WebSocket cleanup runs.
use super::*;
use serde_json::json;

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
        )
        .await
        .unwrap();
    let (hub, router) = Hub::connect(store.clone()).await.unwrap();
    let (send, _messages) = mpsc::channel(8);
    let (shutdown, stopped) = watch::channel(None);
    hub.add_daemon(&machine.id, "socket", send, shutdown)
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
