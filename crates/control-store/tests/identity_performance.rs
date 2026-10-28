//! Regressions for indexed identity reads, bounded expiry and authorization locks.
use deskfleet_control_store::{ControlStore, Error, now_ms, timestamp};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait, Value,
};
use serde_json::json;
use std::time::Duration;

fn sql(query: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

struct Fixture {
    store: ControlStore,
    database: DatabaseConnection,
    schema: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let database = Database::connect(&url).await.unwrap();
        let schema = format!("identity_test_{}", uuid::Uuid::new_v4().simple());
        database
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
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

async fn wait_for_blocker(store: &ControlStore, blocker: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if store
                .database()
                .query_one_raw(sql(
                    "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
                    vec![blocker.into()],
                ))
                .await
                .unwrap()
                .is_some()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the operation reached its parent lock");
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn peer_grants_lock_parents_before_revocable_children() {
    for parent in ["user", "team"] {
        let fixture = Fixture::new().await;
        let store = &fixture.store;
        let admin = store
            .verified_user("owner@fixture.test", "Owner")
            .await
            .unwrap();
        let member = store
            .verified_user("member@fixture.test", "Member")
            .await
            .unwrap();
        let team = store.create_team(&admin.id, "Team").await.unwrap();
        let invite = store
            .invite(&admin.id, &team.id, "member@fixture.test", "member")
            .await
            .unwrap();
        store
            .accept_invite(&member.id, invite["token"].as_str().unwrap())
            .await
            .unwrap();
        let (machine, _) = store
            .enroll(
                &member.id,
                &team.id,
                "Machine",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap();
        let session = store.new_session(&member.id).await.unwrap();
        let login = session["sessionId"].as_str().unwrap().to_owned();
        let expires = now_ms() + 60_000;
        let grant = PeerAuthorization {
            peer_id: "peer-under-test".into(),
            server_id: "server".into(),
            team_id: team.id.clone(),
            actor: PeerActor {
                kind: "user".into(),
                user_id: member.id.clone(),
                device_id: login.clone(),
                source_machine: None,
            },
            target_machine: PeerTarget {
                id: machine.id,
                origin_id: machine.origin_id,
                local_machine_id: machine.local_machine_id,
            },
            purpose: "agent".into(),
            actions: vec!["agent:read".into()],
            issued_at: timestamp(now_ms()),
            expires_at: timestamp(expires),
        };
        let tx = store.database().begin().await.unwrap();
        tx.execute_unprepared("SET LOCAL statement_timeout='2s'")
            .await
            .unwrap();
        let blocker: i32 = tx
            .query_one_raw(sql("SELECT pg_backend_pid() AS pid", vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "pid")
            .unwrap();
        if parent == "user" {
            tx.query_one_raw(sql(
                "SELECT id FROM cp_users WHERE id=$1 FOR UPDATE",
                vec![member.id.clone().into()],
            ))
            .await
            .unwrap();
        } else {
            tx.query_one_raw(sql(
                "SELECT id FROM cp_teams WHERE id=$1 FOR UPDATE",
                vec![team.id.parse::<i64>().unwrap().into()],
            ))
            .await
            .unwrap();
        }
        let other = store.clone();
        let pending = tokio::spawn(async move { other.save_peer(&grant, &login, expires).await });
        wait_for_blocker(store, blocker).await;
        // These are the child mutations made by session/member revocation. A
        // grant holding child locks before its parent would deadlock here.
        if parent == "user" {
            tx.execute_raw(sql(
                "UPDATE cp_login_sessions SET revoked=TRUE WHERE user_id=$1",
                vec![member.id.into()],
            ))
            .await
            .unwrap();
        } else {
            tx.execute_raw(sql(
                "DELETE FROM cp_members WHERE team_id=$1 AND user_id=$2",
                vec![team.id.parse::<i64>().unwrap().into(), member.id.into()],
            ))
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        assert!(
            pending.await.unwrap().is_err(),
            "revoked access cannot create a grant"
        );
        fixture.close().await;
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn credential_proofs_lock_the_user_before_consuming_challenges() {
    for purpose in ["recovery", "email"] {
        let fixture = Fixture::new().await;
        let store = &fixture.store;
        let user = store
            .verified_user("owner@fixture.test", "Owner")
            .await
            .unwrap();
        let token = store
            .issue_identity_challenge(
                purpose,
                Some(&user.id),
                "new@fixture.test",
                json!({"version":0}),
                60_000,
            )
            .await
            .unwrap();
        let tx = store.database().begin().await.unwrap();
        tx.execute_unprepared("SET LOCAL statement_timeout='2s'")
            .await
            .unwrap();
        let blocker: i32 = tx
            .query_one_raw(sql("SELECT pg_backend_pid() AS pid", vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "pid")
            .unwrap();
        tx.query_one_raw(sql(
            "SELECT id FROM cp_users WHERE id=$1 FOR UPDATE",
            vec![user.id.clone().into()],
        ))
        .await
        .unwrap();
        let other = store.clone();
        let user_id = user.id.clone();
        let pending = tokio::spawn(async move {
            if purpose == "recovery" {
                other
                    .recover_password(&token, "replacement-password-hash")
                    .await
            } else {
                other.verify_email_change(&token, &user_id).await
            }
        });
        wait_for_blocker(store, blocker).await;
        tx.execute_raw(sql(
            "UPDATE cp_users SET credential_version=credential_version+1 WHERE id=$1",
            vec![user.id.clone().into()],
        ))
        .await
        .unwrap();
        tx.execute_raw(sql(
            "DELETE FROM cp_identity_challenges WHERE user_id=$1",
            vec![user.id.into()],
        ))
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert!(matches!(pending.await.unwrap(), Err(Error::Unauthorized)));
        fixture.close().await;
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn concurrent_registration_serializes_before_consuming_proofs() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let token = store
        .issue_identity_challenge("registration", None, "new@fixture.test", json!({}), 60_000)
        .await
        .unwrap();
    let tx = store.database().begin().await.unwrap();
    tx.execute_unprepared("SET LOCAL statement_timeout='2s'")
        .await
        .unwrap();
    let blocker: i32 = tx
        .query_one_raw(sql("SELECT pg_backend_pid() AS pid", vec![]))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    tx.execute_unprepared("INSERT INTO cp_users(id,name,email,password_hash) VALUES('winner','Winner','new@fixture.test','winner-hash')").await.unwrap();
    let other = store.clone();
    let pending = tokio::spawn(async move {
        other
            .verify_registration(&token, "Other", "other-hash")
            .await
    });
    wait_for_blocker(store, blocker).await;
    tx.execute_unprepared("DELETE FROM cp_identity_challenges WHERE email='new@fixture.test' AND purpose='registration'").await.unwrap();
    tx.commit().await.unwrap();
    assert!(matches!(pending.await.unwrap(), Err(Error::Conflict(_))));
    assert_eq!(
        store
            .password_credentials("new@fixture.test")
            .await
            .unwrap()
            .unwrap()["passwordHash"],
        "winner-hash"
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn account_search_preserves_literal_unicode_and_short_substrings() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let admin = store
        .verified_user("owner@fixture.test", "Owner")
        .await
        .unwrap();
    store.grant_site_admin(&admin.id).await.unwrap();
    let literal = store
        .verified_user("literal@fixture.test", "MiXeD 100%_\\獾🦊")
        .await
        .unwrap();
    let false_positive = store
        .verified_user("other@fixture.test", "ABC BCD CDE")
        .await
        .unwrap();
    for query in ["%", "_", "\\", "%_", "獾", "獾🦊", "MIXED", " literal@ "] {
        let matches = store.find_accounts(&admin.id, query).await.unwrap();
        assert_eq!(matches.len(), 1, "literal search {query:?}");
        assert_eq!(matches[0]["id"], literal.id);
    }
    for query in ["__", "ABCDE", "absent-needle"] {
        assert!(
            store
                .find_accounts(&admin.id, query)
                .await
                .unwrap()
                .is_empty(),
            "search {query:?} must not match {}",
            false_positive.id
        );
    }
    assert_eq!(store.find_accounts(&admin.id, "").await.unwrap().len(), 3);
    store
        .database()
        .execute_raw(sql(
            "UPDATE cp_users SET name='Replacement' WHERE id=$1",
            vec![literal.id.clone().into()],
        ))
        .await
        .unwrap();
    assert!(
        store
            .find_accounts(&admin.id, "獾")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.find_accounts(&admin.id, "replacement").await.unwrap()[0]["id"],
        literal.id
    );

    // Prove that rare 1-, 2- and 3+-character candidates are all indexable;
    // planner cost decisions on this deliberately tiny fixture are irrelevant.
    let tx = store.database().begin().await.unwrap();
    tx.execute_unprepared("SET LOCAL enable_seqscan=off")
        .await
        .unwrap();
    for needle in ["%", "%_", "absent-needle"] {
        let plan: serde_json::Value = tx.query_one_raw(sql("EXPLAIN (FORMAT JSON) SELECT id FROM cp_users WHERE (cp_account_search_grams(name) || cp_account_search_grams(email)) @> cp_account_search_grams($1)", vec![needle.into()])).await.unwrap().unwrap().try_get("", "QUERY PLAN").unwrap();
        assert!(plan.to_string().contains("cp_users_search"));
    }
    tx.rollback().await.unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn identity_expiry_is_bounded_and_skips_inflight_ceremonies() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let user = store
        .verified_user("owner@fixture.test", "Owner")
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Team").await.unwrap();
    store.database().execute_unprepared("INSERT INTO cp_auth_limits SELECT 'old-'||g,1,1 FROM generate_series(1,3) g; INSERT INTO cp_login_attempts SELECT 'old-'||g,'{}',1 FROM generate_series(1,3) g").await.unwrap();
    store.database().execute_raw(sql("INSERT INTO cp_login_codes SELECT 'old-'||g,$1,'verifier',0,1 FROM generate_series(1,3) g", vec![user.id.clone().into()])).await.unwrap();
    store.database().execute_raw(sql("INSERT INTO cp_identity_challenges SELECT 'old-'||g,'recovery',$1,'owner@fixture.test','{}',1 FROM generate_series(1,3) g", vec![user.id.into()])).await.unwrap();
    store.database().execute_raw(sql("INSERT INTO cp_invites SELECT 'old-'||g,$1,'invite@fixture.test','member',1 FROM generate_series(1,3) g", vec![team.id.parse::<i64>().unwrap().into()])).await.unwrap();
    store.auth_rate_limit("fresh", 3, 60_000).await.unwrap();
    store.save_login_attempt("fresh", json!({})).await.unwrap();
    store
        .issue_identity_challenge(
            "registration",
            None,
            "fresh@fixture.test",
            json!({}),
            60_000,
        )
        .await
        .unwrap();
    for table in [
        "cp_auth_limits",
        "cp_login_attempts",
        "cp_identity_challenges",
    ] {
        let count: i64 = store
            .database()
            .query_one_raw(sql(&format!("SELECT count(*) AS n FROM {table}"), vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "n")
            .unwrap();
        assert_eq!(count, 4, "request paths do not run a global expiry sweep");
    }
    let tx = store.database().begin().await.unwrap();
    tx.query_all_raw(sql(
        "SELECT token_hash FROM cp_identity_challenges WHERE expires_at=1 FOR UPDATE",
        vec![],
    ))
    .await
    .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), store.prune_auth_records(2))
            .await
            .unwrap()
            .unwrap(),
        8
    );
    tx.rollback().await.unwrap();
    assert_eq!(store.prune_auth_records(2).await.unwrap(), 6);
    assert_eq!(store.prune_auth_records(2).await.unwrap(), 1);
    assert_eq!(store.prune_auth_records(2).await.unwrap(), 0);
    for table in [
        "cp_auth_limits",
        "cp_login_attempts",
        "cp_identity_challenges",
    ] {
        let count: i64 = store
            .database()
            .query_one_raw(sql(&format!("SELECT count(*) AS n FROM {table}"), vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "n")
            .unwrap();
        assert_eq!(count, 1, "maintenance retains unexpired credentials");
    }
    fixture.close().await;
}
