//! Upgrade persisted grants before reconciliation decodes the current protocol.
use deskfleet_control_store::{ControlStore, Error, now_ms, timestamp};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget, PeerTransport};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use serde_json::{Value, json};

async fn stored_peers(store: &ControlStore) -> Vec<Value> {
    store
        .database()
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT to_jsonb(p) AS record FROM cp_peers p ORDER BY id",
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "record").unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn peer_transport_upgrade_restores_reconciliation_and_preserves_existing_grants() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("peer_transport_upgrade_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{url}{separator}options=-csearch_path%3D{schema}");
    let store = ControlStore::connect(&scoped_url).await.unwrap();
    let user = store
        .verified_user("owner@fixture.test", "Owner")
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Upgrade").await.unwrap();
    let (machine, _) = store
        .enroll(
            &user.id,
            &team.id,
            "Worker",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let login = store.new_session(&user.id).await.unwrap();
    let auth = store
        .authenticate(login["token"].as_str().unwrap())
        .await
        .unwrap();
    let now = now_ms();
    for (id, transport, expires) in [
        ("legacy-active", PeerTransport::Webrtc, now + 60_000),
        ("legacy-expired", PeerTransport::Webrtc, now - 1),
        ("legacy-revoked", PeerTransport::Webrtc, now + 60_000),
        ("current-local", PeerTransport::Local, now + 60_000),
        ("current-webrtc", PeerTransport::Webrtc, now + 60_000),
    ] {
        let grant = PeerAuthorization {
            peer_id: id.into(),
            server_id: "https://control.test".into(),
            team_id: team.id.clone(),
            actor: PeerActor {
                kind: "user".into(),
                user_id: user.id.clone(),
                device_id: auth.device_id.clone(),
                source_machine: None,
            },
            target_machine: PeerTarget {
                id: machine.id.clone(),
                origin_id: machine.origin_id.clone(),
                local_machine_id: machine.local_machine_id.clone(),
            },
            transport,
            purpose: "agent".into(),
            actions: vec!["agent:read".into()],
            issued_at: timestamp(now - 1000),
            expires_at: timestamp(expires),
        };
        store.save_peer(&grant, &auth.id, expires).await.unwrap();
    }
    store
        .database()
        .execute_unprepared("UPDATE cp_peers SET revoked=TRUE WHERE id='legacy-revoked'")
        .await
        .unwrap();
    let expected = stored_peers(&store).await;
    // Emulate a pre-local-channel database alongside already-current grants.
    store
        .database()
        .execute_unprepared(
            "UPDATE cp_peers SET grant_json=grant_json-'transport' WHERE id LIKE 'legacy-%';
             DELETE FROM cp_migrations WHERE version=11",
        )
        .await
        .unwrap();
    let error = store.valid_machine_peers(&machine.id).await.unwrap_err();
    match error {
        Error::Json(error) => assert_eq!(error.to_string(), "missing field `transport`"),
        other => panic!("expected a stored grant decode failure, got {other:?}"),
    }
    store.close().await.unwrap();

    // Startup must repair the stored shape before daemon reconciliation runs.
    let upgraded = ControlStore::connect(&scoped_url).await.unwrap();
    assert_eq!(stored_peers(&upgraded).await, expected);
    let mut active = upgraded.valid_machine_peers(&machine.id).await.unwrap();
    active.sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
    assert_eq!(
        active
            .iter()
            .map(|peer| (peer.peer_id.as_str(), peer.transport))
            .collect::<Vec<_>>(),
        vec![
            ("current-local", PeerTransport::Local),
            ("current-webrtc", PeerTransport::Webrtc),
            ("legacy-active", PeerTransport::Webrtc),
        ]
    );
    for id in ["legacy-expired", "legacy-revoked"] {
        assert_eq!(
            upgraded
                .peer_for_close(id, &auth.id)
                .await
                .unwrap()
                .transport,
            PeerTransport::Webrtc
        );
    }
    deskfleet_control_store::schema::migrate(upgraded.database())
        .await
        .unwrap();
    assert_eq!(stored_peers(&upgraded).await, expected);
    deskfleet_control_store::schema::down(upgraded.database())
        .await
        .unwrap();
    let migration = upgraded
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT version FROM cp_migrations WHERE version=11",
        ))
        .await
        .unwrap();
    assert!(migration.is_none());
    upgraded.close().await.unwrap();
    admin
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    admin.close().await.unwrap();
}
