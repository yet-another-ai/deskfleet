//! Public machine identity and Team registration boundaries against PostgreSQL.
use deskfleet_control_store::{
    ControlStore, Error, MachineRegistration, now_ms, secret, timestamp,
};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget, PeerTransport};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use serde_json::{Value, json};

struct Fixture {
    store: ControlStore,
    database: DatabaseConnection,
    schema: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let database = Database::connect(&url).await.unwrap();
        let schema = format!("registrations_{}", uuid::Uuid::new_v4().simple());
        database
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap()
                .with_hosted_mode(true);
        Self {
            store,
            database,
            schema,
        }
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.database
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.database.close().await.unwrap();
    }
}

async fn register(
    store: &ControlStore,
    user: &str,
    team: &str,
    identity: &str,
) -> (MachineRegistration, String) {
    store
        .enroll(
            user,
            team,
            "Shared host",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
            identity,
        )
        .await
        .unwrap()
}

async fn history(store: &ControlStore, registration: &str, title: &str) {
    store
        .save_catalog(
            registration,
            "1",
            json!({"machineId":"1","workspaces":[],"sessionIds":["1"]}),
            json!({"providers":[]}),
        )
        .await
        .unwrap();
    store
        .sync_history(
            registration,
            "1",
            json!({
                "session":{"id":"1","title":title,"archiveState":"active","lastEventSeq":"0"},
                "entries":[],"inputs":[],"turns":[],"permissions":[],"elicitations":[]
            }),
            vec![],
            vec![],
        )
        .await
        .unwrap();
}

async fn peer(
    store: &ControlStore,
    registration: &MachineRegistration,
    user: &str,
) -> PeerAuthorization {
    let login = store.new_session(user).await.unwrap();
    let authenticated = store
        .authenticate(login["token"].as_str().unwrap())
        .await
        .unwrap();
    let expires = now_ms() + 60_000;
    let grant = PeerAuthorization {
        peer_id: uuid::Uuid::new_v4().to_string(),
        server_id: "https://test.invalid".into(),
        team_id: registration.team_id.clone(),
        actor: PeerActor {
            kind: "user".into(),
            user_id: user.into(),
            device_id: authenticated.device_id,
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: registration.machine_id.clone(),
            origin_id: registration.origin_id.clone(),
            local_machine_id: registration.local_machine_id.clone(),
        },
        transport: PeerTransport::Webrtc,
        purpose: "agent".into(),
        actions: vec!["agent:read".into()],
        issued_at: timestamp(now_ms()),
        expires_at: timestamp(expires),
    };
    store
        .save_peer(&grant, &authenticated.id, expires)
        .await
        .unwrap();
    grant
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn one_public_machine_has_independent_team_resources_and_revocation() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let alice = store
        .verified_user("alice@test.invalid", "Alice")
        .await
        .unwrap();
    let bob = store
        .verified_user("bob@test.invalid", "Bob")
        .await
        .unwrap();
    let a = store.create_team(&alice.id, "A").await.unwrap();
    let b = store.create_team(&bob.id, "B").await.unwrap();
    let identity = secret();
    let (ra, token_a) = register(store, &alice.id, &a.id, &identity).await;
    let (rb, token_b) = register(store, &bob.id, &b.id, &identity).await;
    assert_eq!(ra.machine_id, rb.machine_id);
    assert_eq!(ra.public().id, rb.public().id);
    assert_ne!(ra.id, rb.id);
    assert_ne!(ra.origin_id, rb.origin_id);
    assert_ne!(token_a, token_b);
    assert_eq!(
        store
            .authorized_registration(&alice.id, &a.id, &ra.machine_id)
            .await
            .unwrap()
            .id,
        ra.id
    );
    assert!(matches!(
        store
            .authorized_registration(&alice.id, &b.id, &ra.machine_id)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .authorized_registration(&bob.id, &a.id, &rb.machine_id)
            .await,
        Err(Error::Forbidden)
    ));
    history(store, &ra.id, "alpha-private").await;
    history(store, &rb.id, "beta-private").await;
    assert_eq!(
        store.session_snapshot(&ra.id, "1").await.unwrap()["snapshot"]["session"]["title"],
        "alpha-private"
    );
    assert_eq!(
        store.session_snapshot(&rb.id, "1").await.unwrap()["snapshot"]["session"]["title"],
        "beta-private"
    );
    assert_eq!(
        store.catalog(&rb.id).await.unwrap()["machineId"],
        rb.machine_id
    );
    let visible = store
        .search(&bob.id, &b.id, "beta-private", "chat", None, 20)
        .await
        .unwrap();
    assert_eq!(visible["results"][0]["machineId"], rb.machine_id);
    assert_eq!(
        store
            .search(&bob.id, &b.id, "alpha-private", "chat", None, 20)
            .await
            .unwrap()["results"],
        json!([])
    );
    for _ in 0..3 {
        store
            .reserve_session(&ra.id, &uuid::Uuid::new_v4().to_string(), "create", None)
            .await
            .unwrap();
    }
    assert!(matches!(
        store
            .reserve_session(&ra.id, &uuid::Uuid::new_v4().to_string(), "create", None)
            .await,
        Err(Error::Conflict("active_session_limit"))
    ));
    store
        .reserve_session(&rb.id, &uuid::Uuid::new_v4().to_string(), "create", None)
        .await
        .unwrap();
    let peer_a = peer(store, &ra, &alice.id).await;
    let peer_b = peer(store, &rb, &bob.id).await;
    assert_eq!(
        store.valid_machine_peers(&ra.id).await.unwrap()[0].peer_id,
        peer_a.peer_id
    );
    assert_eq!(
        store.valid_machine_peers(&rb.id).await.unwrap()[0].peer_id,
        peer_b.peer_id
    );
    let node = uuid::Uuid::new_v4().to_string();
    store.register_node(&node).await.unwrap();
    store
        .claim_machine_route(&ra.id, &node, "connection-a")
        .await
        .unwrap();
    store
        .claim_machine_route(&rb.id, &node, "connection-b")
        .await
        .unwrap();
    assert_eq!(
        store
            .machine_route(&ra.id)
            .await
            .unwrap()
            .unwrap()
            .connection_id,
        "connection-a"
    );
    assert_eq!(
        store
            .machine_route(&rb.id)
            .await
            .unwrap()
            .unwrap()
            .connection_id,
        "connection-b"
    );
    store.revoke_machine(&alice.id, &ra.id).await.unwrap();
    assert_eq!(
        store.revoke_machine_peers(&ra.id).await.unwrap()[0].peer_id,
        peer_a.peer_id
    );
    assert_eq!(
        store.valid_machine_peers(&rb.id).await.unwrap()[0].peer_id,
        peer_b.peer_id
    );
    assert!(store.machine_route(&ra.id).await.unwrap().is_none());
    assert!(store.machine_route(&rb.id).await.unwrap().is_some());
    assert!(matches!(
        store.authenticate_machine(&token_a).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        store
            .authenticate_machine(&token_b)
            .await
            .unwrap()
            .machine
            .id,
        rb.id
    );
    assert!(store.session_admissions(&ra.id).await.unwrap().is_empty());
    assert_eq!(store.session_admissions(&rb.id).await.unwrap().len(), 1);
    assert!(
        store
            .authorized_registration(&alice.id, &a.id, &ra.machine_id)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .authorized_registration(&bob.id, &b.id, &rb.machine_id)
            .await
            .unwrap()
            .id,
        rb.id
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn duplicate_registration_is_atomic_and_reactivation_retains_catalog_identity() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let owner = store
        .verified_user("owner@test.invalid", "Owner")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Team").await.unwrap();
    let identity = secret();
    let origin_a = uuid::Uuid::new_v4().to_string();
    let origin_b = uuid::Uuid::new_v4().to_string();
    let (a, b) = tokio::join!(
        store.enroll(
            &owner.id,
            &team.id,
            "A",
            &origin_a,
            "1",
            json!({}),
            &identity
        ),
        store.enroll(
            &owner.id,
            &team.id,
            "B",
            &origin_b,
            "1",
            json!({}),
            &identity
        ),
    );
    let (registration, token) = match (a, b) {
        (Ok(value), Err(Error::Conflict(_))) | (Err(Error::Conflict(_)), Ok(value)) => value,
        other => panic!("expected one registration and one conflict: {other:?}"),
    };
    history(store, &registration.id, "retained").await;
    assert!(matches!(
        store
            .enroll(
                &owner.id,
                &team.id,
                "Duplicate",
                &registration.origin_id,
                "1",
                json!({}),
                &identity
            )
            .await,
        Err(Error::Conflict(_))
    ));
    assert!(store.authenticate_machine(&token).await.is_ok());
    store
        .revoke_machine(&owner.id, &registration.id)
        .await
        .unwrap();
    assert!(matches!(
        store
            .enroll(
                &owner.id,
                &team.id,
                "Wrong origin",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
                &identity
            )
            .await,
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        store
            .enroll(
                &owner.id,
                &team.id,
                "Wrong local ID",
                &registration.origin_id,
                "2",
                json!({}),
                &identity
            )
            .await,
        Err(Error::Conflict(_))
    ));
    let (restored, rotated) = store
        .enroll(
            &owner.id,
            &team.id,
            "Restored",
            &registration.origin_id,
            "1",
            json!({}),
            &identity,
        )
        .await
        .unwrap();
    assert_eq!(restored.id, registration.id);
    assert_eq!(restored.machine_id, registration.machine_id);
    assert_ne!(rotated, token);
    assert!(store.authenticate_machine(&token).await.is_err());
    assert!(store.authenticate_machine(&rotated).await.is_ok());
    assert_eq!(
        store.session_snapshot(&restored.id, "1").await.unwrap()["snapshot"]["session"]["title"],
        "retained"
    );
    let duplicate = store.database().execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO cp_machine_registrations(machine_id,team_id,owner_id,name,origin_id,local_machine_id,token_hash,capabilities) SELECT machine_id,team_id,owner_id,name,$2,local_machine_id,$3,capabilities FROM cp_machine_registrations WHERE id=$1",
        vec![registration.id.parse::<i64>().unwrap().into(), uuid::Uuid::new_v4().to_string().into(), secret().into()],
    )).await;
    assert!(
        duplicate.is_err(),
        "the database must enforce one association including revoked rows"
    );
    assert!(matches!(
        store
            .enroll(
                &owner.id,
                &team.id,
                "Invalid",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
                " "
            )
            .await,
        Err(Error::Invalid(_))
    ));
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn migration_preserves_legacy_machine_history_and_bootstraps_identity_proof() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let owner = store
        .verified_user("legacy@test.invalid", "Legacy")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Original").await.unwrap();
    let (original, token) = register(store, &owner.id, &team.id, &secret()).await;
    history(store, &original.id, "legacy-session").await;
    // Reconstruct the previous on-disk schema with real persisted records.
    store
        .database()
        .execute_unprepared(include_str!("../src/machine_registrations_down.sql"))
        .await
        .unwrap();
    store
        .database()
        .execute_unprepared("DELETE FROM cp_migrations WHERE version=22")
        .await
        .unwrap();
    deskfleet_control_store::schema::migrate(store.database())
        .await
        .unwrap();
    let migrated = store.authenticate_machine(&token).await.unwrap().machine;
    assert_eq!(migrated.id, original.id);
    assert_eq!(migrated.machine_id, original.id);
    assert_eq!(migrated.origin_id, original.origin_id);
    assert_eq!(
        store.session_snapshot(&migrated.id, "1").await.unwrap()["snapshot"]["session"]["title"],
        "legacy-session"
    );
    let other = store.create_team(&owner.id, "Other").await.unwrap();
    let (added, _) = register(store, &owner.id, &other.id, &token).await;
    assert_eq!(added.machine_id, migrated.machine_id);
    assert_ne!(added.id, migrated.id);
    // Re-running migrations and the renamed projection trigger stay valid.
    deskfleet_control_store::schema::migrate(store.database())
        .await
        .unwrap();
    history(store, &added.id, "new-team-session").await;
    let count: i64 = store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT COUNT(*) AS count FROM cp_machine_registrations".to_owned(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap();
    assert_eq!(count, 2);
    let providers: Value = store.catalog(&migrated.id).await.unwrap()["providers"].clone();
    assert_eq!(providers, json!({"providers":[]}));
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn reactivation_retains_admissions_and_competes_atomically_for_team_capacity() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let owner = store
        .verified_user("quota@test.invalid", "Owner")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Team").await.unwrap();
    let identity = secret();
    let (returning, old_token) = register(store, &owner.id, &team.id, &identity).await;
    let (active, _) = register(store, &owner.id, &team.id, &secret()).await;
    let committed = uuid::Uuid::new_v4().to_string();
    let pending = uuid::Uuid::new_v4().to_string();
    for operation in [&committed, &pending] {
        store
            .reserve_session(&returning.id, operation, "create", None)
            .await
            .unwrap();
    }
    store
        .confirm_session_admission(&returning.id, &committed, &committed, "1")
        .await
        .unwrap();
    store
        .reserve_session(
            &active.id,
            &uuid::Uuid::new_v4().to_string(),
            "create",
            None,
        )
        .await
        .unwrap();
    store
        .revoke_machine(&owner.id, &returning.id)
        .await
        .unwrap();
    assert!(
        store
            .session_admissions(&returning.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.team_usage(&owner.id, &team.id).await.unwrap()["activeSessionCount"],
        1
    );
    let contender = uuid::Uuid::new_v4().to_string();
    let (reactivation, reservation) = tokio::join!(
        store.enroll(
            &owner.id,
            &team.id,
            "Returning",
            &returning.origin_id,
            "1",
            json!({}),
            &identity
        ),
        store.reserve_session(&active.id, &contender, "create", None),
    );
    let restored = match (reactivation, reservation) {
        (Ok((restored, _)), Err(Error::Conflict("active_session_limit"))) => restored,
        (Err(Error::Conflict("active_session_limit")), Ok(_)) => {
            assert!(store.authenticate_machine(&old_token).await.is_err());
            store
                .cancel_session_admission(&active.id, &contender, &contender)
                .await
                .unwrap();
            store
                .enroll(
                    &owner.id,
                    &team.id,
                    "Returning",
                    &returning.origin_id,
                    "1",
                    json!({}),
                    &identity,
                )
                .await
                .unwrap()
                .0
        }
        result => {
            panic!("reactivation and new work must compete for the same Team capacity: {result:?}")
        }
    };
    assert_eq!(restored.id, returning.id);
    let admissions = store.session_admissions(&restored.id).await.unwrap();
    assert_eq!(admissions.len(), 2);
    assert_eq!(
        admissions
            .iter()
            .find(|value| value["admissionId"] == committed)
            .unwrap()["status"],
        "committed"
    );
    assert_eq!(
        admissions
            .iter()
            .find(|value| value["admissionId"] == pending)
            .unwrap()["status"],
        "reserved"
    );
    assert_eq!(
        store.team_usage(&owner.id, &team.id).await.unwrap()["activeSessionCount"],
        3
    );
    // The daemon's existing reconciliation can still confirm unknown outcomes
    // and acknowledge archives using the original durable generations.
    store
        .confirm_session_admission(&restored.id, &pending, &pending, "2")
        .await
        .unwrap();
    store
        .release_session_admission(&restored.id, "1", &committed)
        .await
        .unwrap();
    assert_eq!(
        store.team_usage(&owner.id, &team.id).await.unwrap()["activeSessionCount"],
        2
    );
    store
        .reserve_session(
            &active.id,
            &uuid::Uuid::new_v4().to_string(),
            "create",
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        store.team_usage(&owner.id, &team.id).await.unwrap()["activeSessionCount"],
        3
    );
    fixture.close().await;
}
