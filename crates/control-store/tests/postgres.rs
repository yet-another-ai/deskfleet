//! Run explicitly against PostgreSQL: TEST_DATABASE_URL=postgres://... cargo test
//! -p deskfleet-control-store --test postgres -- --ignored.
use deskfleet_control_store::{ControlStore, Error, now_ms, timestamp};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget};
use serde_json::{Value, json};

fn snapshot(id: &str, seq: &str) -> Value {
    json!({"session":{"id":id,"workspaceId":"1","lastEventSeq":seq,"archiveState":"active"},"runs":[],"inputs":[],"turns":[],"permissions":[],"elicitations":[]})
}
fn event(id: &str, seq: &str) -> Value {
    json!({"sessionId":id,"seq":seq,"kind":"acp","payload":{"text":format!("event {seq}")}})
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_roles_tokens_replication_and_revocation() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL to PostgreSQL");
    let store = ControlStore::connect(&url).await.unwrap();
    assert!(ControlStore::connect("sqlite::memory:").await.is_err());
    let issuer = format!("https://fixture/{}", uuid::Uuid::new_v4());
    let admin = store
        .oidc_user(&issuer, "owner", "Owner", Some("owner@example.test"), true)
        .await
        .unwrap();
    let member = store
        .oidc_user(
            &issuer,
            "member",
            "Member",
            Some("member@example.test"),
            true,
        )
        .await
        .unwrap();
    let outsider = store
        .oidc_user(&issuer, "outsider", "Outsider", None, false)
        .await
        .unwrap();
    let team = store.create_team(&admin.id, "First team").await.unwrap();
    assert!(matches!(
        store
            .change_member(&admin.id, &team.id, &admin.id, None)
            .await,
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        store.team_role(&outsider.id, &team.id).await,
        Err(Error::Forbidden)
    ));
    let invite = store
        .invite(&admin.id, &team.id, "member@example.test", "member")
        .await
        .unwrap();
    assert!(matches!(
        store
            .accept_invite(&outsider.id, invite["token"].as_str().unwrap())
            .await,
        Err(Error::Forbidden)
    ));
    store
        .accept_invite(&member.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    assert!(
        store
            .accept_invite(&member.id, invite["token"].as_str().unwrap())
            .await
            .is_err()
    );
    assert!(matches!(
        store.require_admin(&member.id, &team.id).await,
        Err(Error::Forbidden)
    ));
    let session = store.new_session(&member.id).await.unwrap();
    let token = session["token"].as_str().unwrap();
    let auth = store.authenticate(token).await.unwrap();
    let (machine, machine_token) = store
        .enroll(
            &member.id,
            &team.id,
            "Worker",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .authenticate_machine(&machine_token)
            .await
            .unwrap()
            .machine
            .id,
        machine.id
    );
    assert!(
        store
            .authorized_machine(&outsider.id, &machine.id)
            .await
            .is_err()
    );
    assert!(store.revoke_machine(&member.id, &machine.id).await.is_err());
    store
        .save_catalog(
            &machine.id,
            json!({"machineId":"1","workspaces":[]}),
            json!({"providers":[]}),
        )
        .await
        .unwrap();
    assert_eq!(
        store.catalog(&machine.id).await.unwrap()["snapshot"]["machineId"],
        "1"
    );
    assert_eq!(store.sync_history(&machine.id,"1",snapshot("1","2"),vec![event("1","1")],vec![json!({"id":"1","sessionId":"1","operationId":"op","isCanonical":true,"status":"accepted"})]).await.unwrap(),"1");
    assert_eq!(
        store.session_snapshot(&machine.id, "1").await.unwrap()["snapshot"]["session"]["lastEventSeq"],
        "2"
    );
    assert!(
        store
            .sync_history(
                &machine.id,
                "1",
                snapshot("1", "4"),
                vec![event("1", "3")],
                vec![]
            )
            .await
            .is_err()
    );
    assert_eq!(store.sync_history(&machine.id,"1",snapshot("1","2"),vec![event("1","1"),event("1","2")],vec![json!({"id":"1","sessionId":"1","operationId":"op","isCanonical":true,"status":"completed"})]).await.unwrap(),"2");
    assert_eq!(store.sync_history(&machine.id,"1",snapshot("1","1"),vec![event("1","1")],vec![json!({"id":"1","sessionId":"1","operationId":"op","isCanonical":true,"status":"accepted"})]).await.unwrap(),"2");
    assert_eq!(
        store.command_by_operation(&machine.id, "op").await.unwrap()["status"],
        "completed"
    );
    let mut changed = event("1", "1");
    changed["payload"] = json!({"text":"changed"});
    assert!(
        store
            .sync_history(&machine.id, "1", snapshot("1", "2"), vec![changed], vec![])
            .await
            .is_err()
    );
    assert_eq!(
        store.events(&machine.id, "1", 0, 200).await.unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    store
        .sync_history(&machine.id, "2", snapshot("2", "0"), vec![], vec![])
        .await
        .unwrap();
    let mut archived = snapshot("10", "0");
    archived["session"]["archiveState"] = json!("archived");
    store
        .sync_history(&machine.id, "10", archived, vec![], vec![])
        .await
        .unwrap();
    let first = store.sessions(&machine.id, 0, 2, "all").await.unwrap();
    assert_eq!(first["sessions"][0]["session"]["id"], "1");
    assert_eq!(first["sessions"][1]["session"]["id"], "2");
    assert_eq!(first["nextCursor"], "2");
    let last = store.sessions(&machine.id, 2, 2, "all").await.unwrap();
    assert_eq!(last["sessions"][0]["session"]["id"], "10");
    assert!(last.get("nextCursor").is_none());
    assert_eq!(
        store
            .sessions(&machine.id, 0, 200, "archived")
            .await
            .unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    store
        .sync_history(
            &machine.id,
            "1",
            snapshot("1", "2"),
            vec![],
            vec![
                json!({"id":"2","sessionId":"1"}),
                json!({"id":"10","sessionId":"1"}),
            ],
        )
        .await
        .unwrap();
    let commands = store.commands(&machine.id, "1", 0, 2).await.unwrap();
    assert_eq!(commands["commands"][1]["id"], "2");
    assert_eq!(commands["nextCursor"], "2");
    let commands = store.commands(&machine.id, "1", 2, 2).await.unwrap();
    assert_eq!(commands["commands"][0]["id"], "10");
    assert!(commands.get("nextCursor").is_none());
    assert!(store.sessions(&machine.id, 0, 1001, "all").await.is_err());
    let question = json!({
        "id": "30", "sessionId": "20", "runGeneration": 1,
        "request": {"mode": "form", "message": "Choose a scope"},
        "state": "cancelled", "response": {"action": "cancel"},
        "createdAt": "2026-10-25T00:00:00Z", "resolvedAt": "2026-10-25T00:00:01Z"
    });
    let mut archived_question = snapshot("20", "1");
    archived_question["session"]["archiveState"] = json!("archived");
    archived_question["elicitations"] = json!([question]);
    let question_event = json!({
        "sessionId": "20", "seq": "1", "kind": "elicitation", "payload": question
    });
    store
        .sync_history(
            &machine.id,
            "20",
            archived_question.clone(),
            vec![question_event.clone()],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        store.session_snapshot(&machine.id, "20").await.unwrap()["snapshot"],
        archived_question
    );
    assert_eq!(
        store.events(&machine.id, "20", 0, 200).await.unwrap()["events"],
        json!([question_event])
    );
    store
        .set_machine_capabilities(&machine.id, json!({"agent":true,"desktop":false}))
        .await
        .unwrap();
    assert_eq!(
        store.machine(&machine.id).await.unwrap().capabilities["desktop"],
        false
    );
    let peer = PeerAuthorization {
        peer_id: uuid::Uuid::new_v4().to_string(),
        server_id: "https://control.test".into(),
        team_id: team.id.clone(),
        actor: PeerActor {
            kind: "user".into(),
            user_id: member.id.clone(),
            device_id: auth.device_id.clone(),
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: machine.id.clone(),
            origin_id: machine.origin_id.clone(),
            local_machine_id: "1".into(),
        },
        purpose: "agent".into(),
        actions: vec!["agent:read".into()],
        issued_at: timestamp(now_ms()),
        expires_at: timestamp(now_ms() + 86_400_000),
    };
    store
        .save_peer(&peer, &auth.id, now_ms() + 86_400_000)
        .await
        .unwrap();
    assert_eq!(
        store.valid_machine_peers(&machine.id).await.unwrap().len(),
        1
    );
    assert!(store.peer(&peer.peer_id, "another-login").await.is_err());
    store.logout(&auth.id).await.unwrap();
    assert!(store.authenticate(token).await.is_err());
    assert!(
        store
            .valid_machine_peers(&machine.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.revoke_login_peers(&auth.id).await.unwrap().len(), 1);
    store.revoke_machine(&admin.id, &machine.id).await.unwrap();
    assert!(store.authenticate_machine(&machine_token).await.is_err());
    let code = store
        .new_login_code(
            &member.id,
            &deskfleet_control_store::secret_hash("verifier"),
        )
        .await
        .unwrap();
    assert!(store.exchange_login_code(&code, "wrong").await.is_err());
    assert!(store.exchange_login_code(&code, "verifier").await.is_ok());
    assert!(store.exchange_login_code(&code, "verifier").await.is_err());
    store.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_team_usage_counts_current_members_and_latest_unarchived_sessions() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL to PostgreSQL");
    let store = ControlStore::connect(&url).await.unwrap();
    let issuer = format!("https://usage-fixture/{}", uuid::Uuid::new_v4());
    let admin = store
        .oidc_user(&issuer, "admin", "Admin", None, false)
        .await
        .unwrap();
    let member = store
        .oidc_user(
            &issuer,
            "member",
            "Member",
            Some("member@test.example"),
            true,
        )
        .await
        .unwrap();
    let team = store.create_team(&admin.id, "Usage team").await.unwrap();
    let other = store.create_team(&admin.id, "Other team").await.unwrap();
    assert_eq!(
        store.team_usage(&admin.id, &team.id).await.unwrap(),
        json!({"relayedBytes":"0", "activeSessionCount":0, "memberCount":1})
    );
    let invite = store
        .invite(&admin.id, &team.id, "member@test.example", "member")
        .await
        .unwrap();
    assert_eq!(
        store.team_usage(&admin.id, &team.id).await.unwrap()["memberCount"],
        1
    );
    store
        .accept_invite(&member.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        store.team_usage(&member.id, &team.id).await.unwrap()["memberCount"],
        2
    );

    let mut machines = Vec::new();
    for (name, team_id) in [
        ("first", &team.id),
        ("second", &team.id),
        ("other", &other.id),
    ] {
        let (machine, _) = store
            .enroll(
                &admin.id,
                team_id,
                name,
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap();
        // These machines have never connected or reported presence.
        assert!(!machine.online);
        assert!(machine.last_seen_at.is_none());
        machines.push(machine);
    }
    for (machine, session_id, archive_state) in [
        (&machines[0], "1", "active"),
        (&machines[0], "2", "archived"),
        (&machines[0], "3", "archiving"),
        (&machines[1], "1", "active"),
        (&machines[2], "1", "active"),
    ] {
        let mut state = snapshot(session_id, "0");
        state["session"]["archiveState"] = json!(archive_state);
        store
            .sync_history(&machine.id, session_id, state, vec![], vec![])
            .await
            .unwrap();
    }
    assert_eq!(
        store.team_usage(&member.id, &team.id).await.unwrap(),
        json!({"relayedBytes":"0", "activeSessionCount":3, "memberCount":2})
    );
    assert_eq!(
        store.team_usage(&admin.id, &other.id).await.unwrap(),
        json!({"relayedBytes":"0", "activeSessionCount":1, "memberCount":1})
    );
    // Archive, reject an older active snapshot, then restore the same Session.
    for (seq, archive_state, expected) in
        [("1", "archived", 2), ("0", "active", 2), ("2", "active", 3)]
    {
        let mut state = snapshot("1", seq);
        state["session"]["archiveState"] = json!(archive_state);
        store
            .sync_history(&machines[0].id, "1", state, vec![], vec![])
            .await
            .unwrap();
        assert_eq!(
            store.team_usage(&admin.id, &team.id).await.unwrap()["activeSessionCount"],
            expected
        );
    }
    store
        .revoke_machine(&admin.id, &machines[1].id)
        .await
        .unwrap();
    assert_eq!(
        store.team_usage(&admin.id, &team.id).await.unwrap()["activeSessionCount"],
        2
    );
    store
        .change_member(&admin.id, &team.id, &member.id, None)
        .await
        .unwrap();
    assert_eq!(
        store.team_usage(&admin.id, &team.id).await.unwrap(),
        json!({"relayedBytes":"0", "activeSessionCount":2, "memberCount":1})
    );
    assert!(matches!(
        store.team_usage(&member.id, &team.id).await,
        Err(Error::Forbidden)
    ));
    assert_eq!(
        store.team_usage(&admin.id, &other.id).await.unwrap()["activeSessionCount"],
        1
    );
    store.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_migration_can_revert_and_reapply_in_isolated_schema() {
    use sea_orm::{ConnectOptions, ConnectionTrait, Database, DbBackend, Statement};
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL to PostgreSQL");
    let mut options = ConnectOptions::new(url);
    options.max_connections(1).min_connections(1);
    let db = Database::connect(options).await.unwrap();
    let schema = format!("migration_test_{}", uuid::Uuid::new_v4().simple());
    db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    db.execute_unprepared(&format!("SET search_path TO {schema}"))
        .await
        .unwrap();
    db.execute_unprepared("CREATE TABLE cp_migrations (version INTEGER PRIMARY KEY)")
        .await
        .unwrap();
    db.execute_unprepared(include_str!("../src/schema.sql"))
        .await
        .unwrap();
    db.execute_unprepared(
        "INSERT INTO cp_migrations VALUES (1); INSERT INTO cp_teams(name) VALUES ('existing team')",
    )
    .await
    .unwrap();
    deskfleet_control_store::schema::migrate(&db).await.unwrap();
    let row = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT EXISTS(SELECT 1 FROM cp_teams WHERE name='existing team') AND to_regclass('cp_turn_usage') IS NOT NULL AS upgraded",
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(row.try_get::<bool>("", "upgraded").unwrap());
    deskfleet_control_store::schema::migrate(&db).await.unwrap();
    deskfleet_control_store::schema::down(&db).await.unwrap();
    let row = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT to_regclass('cp_users') IS NULL AND to_regclass('cp_turn_usage') IS NULL AS removed",
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(row.try_get::<bool>("", "removed").unwrap());
    deskfleet_control_store::schema::migrate(&db).await.unwrap();
    db.execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    db.close().await.unwrap();
}
