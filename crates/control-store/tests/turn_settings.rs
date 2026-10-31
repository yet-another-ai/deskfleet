//! TURN settings are private, persistent installation state, separate from issued peer grants.
use deskfleet_control_store::{ControlStore, Error, now_ms, timestamp};
use deskfleet_protocol::control::{
    IceServer, PeerActor, PeerAuthorization, PeerTarget, PeerTransport, TurnSettings,
};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use serde_json::{Value, json};

struct Fixture {
    admin: DatabaseConnection,
    schema: String,
    url: String,
    store: ControlStore,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let admin = Database::connect(&url).await.unwrap();
        let schema = format!("turn_settings_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let url = format!("{url}{separator}options=-csearch_path%3D{schema}");
        let store = ControlStore::connect(&url).await.unwrap();
        Self {
            admin,
            schema,
            url,
            store,
        }
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.admin
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.admin.close().await.unwrap();
    }
}

fn endpoints(urls: &[&str]) -> TurnSettings {
    TurnSettings {
        urls: urls.iter().map(|value| (*value).into()).collect(),
    }
}

async fn audit(store: &ControlStore) -> Vec<Value> {
    store
        .database()
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT to_jsonb(a) AS record FROM cp_site_audit a WHERE action='turn.settings.update' ORDER BY id",
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "record").unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn settings_are_seeded_once_private_persistent_and_audited() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let admin = store
        .verified_user("admin@fixture.test", "Admin")
        .await
        .unwrap();
    let member = store
        .verified_user("member@fixture.test", "Member")
        .await
        .unwrap();
    let original = endpoints(&[
        "turn:first.test:3478?transport=udp",
        "turns:second.test:5349?transport=tcp",
    ]);
    store.seed_turn_settings(&original.urls).await.unwrap();
    assert_eq!(store.turn_settings().await.unwrap(), original);
    assert!(audit(store).await.is_empty());
    // A later replica's environment cannot replace the initial deployment seed.
    let second = ControlStore::connect(&fixture.url).await.unwrap();
    second
        .seed_turn_settings(&endpoints(&["turn:other.test"]).urls)
        .await
        .unwrap();
    assert_eq!(second.turn_settings().await.unwrap(), original);
    for user in [&admin.id, &member.id] {
        assert!(matches!(
            store.read_turn_settings(user).await,
            Err(Error::Forbidden)
        ));
        assert!(matches!(
            store.update_turn_settings(user, &original).await,
            Err(Error::Forbidden)
        ));
    }
    store.grant_site_admin(&admin.id).await.unwrap();
    assert_eq!(store.read_turn_settings(&admin.id).await.unwrap(), original);
    let changed = endpoints(&[
        "turns:second.test:5349?transport=tcp",
        "turn:first.test:3478?transport=udp",
    ]);
    let padded = TurnSettings {
        urls: changed
            .urls
            .iter()
            .map(|value| format!(" {value} "))
            .collect(),
    };
    assert_eq!(
        store
            .update_turn_settings(&admin.id, &padded)
            .await
            .unwrap(),
        changed
    );
    assert_eq!(second.turn_settings().await.unwrap(), changed);
    assert!(
        serde_json::to_value(store.site_settings().await.unwrap())
            .unwrap()
            .get("urls")
            .is_none()
    );
    for invalid in [
        endpoints(&["turn:valid.test", " "]),
        endpoints(&["turn:valid.test", "https://invalid.test"]),
        endpoints(&["turn:valid.test", "turn:invalid.test:99999"]),
    ] {
        assert!(matches!(
            store.update_turn_settings(&admin.id, &invalid).await,
            Err(Error::Invalid(_))
        ));
    }
    assert_eq!(second.turn_settings().await.unwrap(), changed);
    let entries = audit(store).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["actor_user_id"], admin.id);
    assert_eq!(entries[0]["source"], "user");
    assert_eq!(entries[0]["before_value"], json!(original));
    assert_eq!(entries[0]["after_value"], json!(changed));

    store.database().execute_unprepared(
        "CREATE FUNCTION reject_turn_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
         CREATE TRIGGER reject_turn_audit BEFORE INSERT ON cp_site_audit FOR EACH ROW EXECUTE FUNCTION reject_turn_audit()",
    ).await.unwrap();
    assert!(
        store
            .update_turn_settings(&admin.id, &TurnSettings::default())
            .await
            .is_err()
    );
    assert_eq!(second.turn_settings().await.unwrap(), changed);
    store
        .database()
        .execute_unprepared(
            "DROP TRIGGER reject_turn_audit ON cp_site_audit; DROP FUNCTION reject_turn_audit()",
        )
        .await
        .unwrap();

    store
        .update_turn_settings(&admin.id, &TurnSettings::default())
        .await
        .unwrap();
    second.seed_turn_settings(&original.urls).await.unwrap();
    assert_eq!(
        second.turn_settings().await.unwrap(),
        TurnSettings::default()
    );
    second.close().await.unwrap();
    let restarted = ControlStore::connect(&fixture.url).await.unwrap();
    restarted.seed_turn_settings(&original.urls).await.unwrap();
    assert_eq!(
        restarted.read_turn_settings(&admin.id).await.unwrap(),
        TurnSettings::default()
    );
    store.revoke_site_admin(&admin.id).await.unwrap();
    assert!(matches!(
        restarted.read_turn_settings(&admin.id).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        restarted.update_turn_settings(&admin.id, &original).await,
        Err(Error::Forbidden)
    ));
    assert_eq!(audit(store).await.len(), 2);
    restarted.close().await.unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn upgrade_keeps_existing_settings_and_peer_snapshots_survive_list_changes() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let user = store
        .verified_user("owner@fixture.test", "Owner")
        .await
        .unwrap();
    store.grant_site_admin(&user.id).await.unwrap();
    let team = store.create_team(&user.id, "Test team").await.unwrap();
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
    let grant = PeerAuthorization {
        peer_id: "existing-peer".into(),
        server_id: "https://control.test".into(),
        team_id: team.id,
        actor: PeerActor {
            kind: "user".into(),
            user_id: user.id.clone(),
            device_id: auth.device_id,
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: machine.id,
            origin_id: machine.origin_id,
            local_machine_id: machine.local_machine_id,
        },
        transport: PeerTransport::Webrtc,
        purpose: "agent".into(),
        actions: vec!["agent:read".into()],
        issued_at: timestamp(now),
        expires_at: timestamp(now + 60_000),
    };
    store
        .save_peer(&grant, &auth.id, now + 60_000)
        .await
        .unwrap();
    store.database().execute_unprepared(
        "UPDATE cp_site_settings SET site_name='Existing fleet';
         ALTER TABLE cp_peers DROP COLUMN ice_servers;
         DROP TABLE cp_turn_settings;
         ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
         ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update', 'account.disable', 'registration.update'));
         DELETE FROM cp_migrations WHERE version=20",
    ).await.unwrap();
    let upgraded = ControlStore::connect(&fixture.url).await.unwrap();
    assert_eq!(
        upgraded.site_settings().await.unwrap().site_name,
        "Existing fleet"
    );
    assert!(
        upgraded
            .peer_ice_servers(&grant.peer_id)
            .await
            .unwrap()
            .is_none()
    );
    // Old API instances still use this INSERT without an ice_servers column.
    // Their grants must be distinguishable from a deliberately empty snapshot.
    let mut rolling_grant = grant.clone();
    rolling_grant.peer_id = "rolling-deployment-peer".into();
    store
        .save_peer(&rolling_grant, &auth.id, now + 60_000)
        .await
        .unwrap();
    assert!(
        upgraded
            .peer_ice_servers(&rolling_grant.peer_id)
            .await
            .unwrap()
            .is_none()
    );
    upgraded.seed_turn_settings(&[]).await.unwrap();
    upgraded
        .seed_turn_settings(&endpoints(&["turn:ignored.test"]).urls)
        .await
        .unwrap();
    assert_eq!(
        upgraded.turn_settings().await.unwrap(),
        TurnSettings::default()
    );
    let servers = vec![IceServer {
        urls: vec!["turn:issued.test:3478?transport=udp".into()],
        username: Some("short-lived-user".into()),
        credential: Some("short-lived-credential".into()),
    }];
    let saved = upgraded
        .save_peer_ice_servers(&grant.peer_id, &servers)
        .await
        .unwrap();
    assert_eq!(json!(saved), json!(servers));
    upgraded
        .update_turn_settings(&user.id, &endpoints(&["turn:replacement.test"]))
        .await
        .unwrap();
    assert_eq!(
        json!(
            store
                .peer_ice_servers(&grant.peer_id)
                .await
                .unwrap()
                .unwrap()
        ),
        json!(servers)
    );
    let replacement = vec![IceServer {
        urls: vec!["turn:replacement.test:3478?transport=udp".into()],
        username: Some("replacement-user".into()),
        credential: Some("replacement-credential".into()),
    }];
    assert_eq!(
        json!(
            store
                .save_peer_ice_servers(&grant.peer_id, &replacement)
                .await
                .unwrap()
        ),
        json!(servers)
    );
    let (first, second) = tokio::join!(
        store.save_peer_ice_servers(&rolling_grant.peer_id, &servers),
        upgraded.save_peer_ice_servers(&rolling_grant.peer_id, &replacement),
    );
    let first = json!(first.unwrap());
    let second = json!(second.unwrap());
    assert_eq!(first, second);
    assert!(first == json!(servers) || first == json!(replacement));
    assert_eq!(
        json!(
            store
                .peer_ice_servers(&rolling_grant.peer_id)
                .await
                .unwrap()
                .unwrap()
        ),
        first
    );

    let mut direct_grant = grant.clone();
    direct_grant.peer_id = "direct-only-peer".into();
    store
        .save_peer(&direct_grant, &auth.id, now + 60_000)
        .await
        .unwrap();
    assert!(
        store
            .save_peer_ice_servers(&direct_grant.peer_id, &[])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        json!(
            upgraded
                .peer_ice_servers(&direct_grant.peer_id)
                .await
                .unwrap()
        ),
        json!([])
    );
    assert!(
        upgraded
            .save_peer_ice_servers(&direct_grant.peer_id, &servers)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        upgraded.peer_ice_servers("missing-peer").await,
        Err(Error::NotFound)
    ));
    deskfleet_control_store::schema::down(upgraded.database())
        .await
        .unwrap();
    let removed: bool = upgraded.database().query_one_raw(Statement::from_string(
        DbBackend::Postgres,
        "SELECT to_regclass('cp_turn_settings') IS NULL AND NOT EXISTS(SELECT 1 FROM cp_migrations WHERE version=20) AS removed",
    )).await.unwrap().unwrap().try_get("", "removed").unwrap();
    assert!(removed);
    upgraded.close().await.unwrap();
    fixture.close().await;
}
