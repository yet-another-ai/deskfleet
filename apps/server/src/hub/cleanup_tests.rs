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
