//! Site-wide creation, deletion and consumption accounting against PostgreSQL.
use deskfleet_control_store::{ControlStore, Error, now_ms, timestamp};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use serde_json::{Value, json};

const DAY_MS: i64 = 86_400_000;

fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

struct Fixture {
    store: ControlStore,
    db: DatabaseConnection,
    schema: String,
    admin: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let db = Database::connect(&url).await.unwrap();
        let schema = format!("site_usage_{}", uuid::Uuid::new_v4().simple());
        db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let admin = store
            .verified_user("admin@site-usage.test", "Administrator")
            .await
            .unwrap()
            .id;
        store.grant_site_admin(&admin).await.unwrap();
        Self {
            store,
            db,
            schema,
            admin,
        }
    }

    async fn exec(&self, query: &str, values: Vec<sea_orm::Value>) {
        self.store
            .database()
            .execute_raw(sql(query, values))
            .await
            .unwrap();
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.db
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.db.close().await.unwrap();
    }
}

fn bucket(result: &Value, day: i64) -> &Value {
    let date = &timestamp(day)[..10];
    result["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["date"] == date)
        .unwrap()
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn daily_counts_use_creation_and_deletion_dates_and_keep_usage_after_cleanup() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let base = now_ms().div_euclid(DAY_MS) * DAY_MS - 6 * DAY_MS;
    let outsider = store
        .verified_user("outside@site-usage.test", "Outside")
        .await
        .unwrap();
    assert!(matches!(
        store.site_usage_trends(&outsider.id, "7d").await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store.site_usage_trends(&fixture.admin, "all").await,
        Err(Error::Invalid(_))
    ));
    let disabled = store
        .verified_user("disabled@site-usage.test", "Disabled")
        .await
        .unwrap();
    fixture
        .exec(
            "UPDATE cp_users SET created_at=$1 WHERE id=$2",
            vec![(base - DAY_MS).into(), fixture.admin.clone().into()],
        )
        .await;
    fixture
        .exec(
            "UPDATE cp_users SET created_at=$1,deleted_at=$2 WHERE id=$3",
            vec![
                (base + DAY_MS).into(),
                (base + 3 * DAY_MS).into(),
                outsider.id.into(),
            ],
        )
        .await;
    fixture
        .exec(
            "UPDATE cp_users SET created_at=$1,disabled=true WHERE id=$2",
            vec![(base + 2 * DAY_MS).into(), disabled.id.into()],
        )
        .await;
    let team = store
        .create_team(&fixture.admin, "Usage fixture")
        .await
        .unwrap();
    let team_id: i64 = team.id.parse().unwrap();
    fixture
        .exec(
            "UPDATE cp_teams SET created_at=$1 WHERE id=$2",
            vec![(base + DAY_MS).into(), team_id.into()],
        )
        .await;
    let (machine, _) = store
        .enroll(
            &fixture.admin,
            &team.id,
            "Usage machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
            &deskfleet_control_store::secret(),
        )
        .await
        .unwrap();
    let registration: i64 = machine.id.parse().unwrap();
    let ended = timestamp(base + DAY_MS + 1234);
    let mut snapshot = json!({
        "session":{"id":"1","title":"Archived","createdAt":timestamp(base+DAY_MS),"archivedAt":timestamp(base+2*DAY_MS),"lastEventSeq":"0"},
        "inputs":[],
        "turns":[
            {"id":"1","state":"completed","consumed":true,"endedAt":ended},
            {"id":"2","state":"cancelled","consumed":true,"endedAt":ended},
            {"id":"3","state":"failed","consumed":false,"endedAt":ended},
            {"id":"4","state":"running","consumed":true,"endedAt":ended}
        ]
    });
    store
        .sync_history(&machine.id, "1", snapshot.clone(), vec![], vec![])
        .await
        .unwrap();
    // A re-sync changes observation, but never the original creation or turn count.
    snapshot["session"]["createdAt"] = json!(timestamp(base + 3 * DAY_MS));
    store
        .sync_history(&machine.id, "1", snapshot, vec![], vec![])
        .await
        .unwrap();
    store.sync_history(&machine.id, "2", json!({"session":{"id":"2","title":"Current","createdAt":timestamp(base+2*DAY_MS),"lastEventSeq":"0"},"turns":[],"inputs":[]}), vec![], vec![]).await.unwrap();
    fixture
        .exec(
            "UPDATE cp_sessions SET deleted_at=$1 WHERE registration_id=$2 AND session_id='1'",
            vec![(base + 4 * DAY_MS).into(), registration.into()],
        )
        .await;
    fixture
        .exec(
            "UPDATE cp_sessions SET snapshot='{}' WHERE registration_id=$1 AND session_id='1'",
            vec![registration.into()],
        )
        .await;
    store
        .revoke_machine(&fixture.admin, &machine.id)
        .await
        .unwrap();
    for (at, side, bytes) in [
        (base + DAY_MS, "client", 13_i64),
        (base + DAY_MS + 10, "peer", 17),
        (base - 4 * DAY_MS, "client", 19),
    ] {
        fixture.exec("INSERT INTO cp_turn_usage(peer_id,team_id,realm,allocation_id,side,received_bytes,sent_bytes,collected_at) VALUES('retained-peer',$1,'test','allocation',$2,999,$3,$4)",vec![team_id.into(),side.into(),bytes.into(),at.into()]).await;
    }
    let result = store.site_usage_trends(&fixture.admin, "7d").await.unwrap();
    assert_eq!(result["buckets"].as_array().unwrap().len(), 7);
    assert_eq!(result["totals"], json!({"users":2,"teams":1,"sessions":1}));
    assert_eq!(result["timeZone"], "UTC");
    assert_eq!(result["relayHistoryIncomplete"], false);
    assert_eq!(bucket(&result, base)["users"], 1);
    assert_eq!(bucket(&result, base)["teams"], 0);
    assert_eq!(bucket(&result, base)["sessions"], 0);
    assert_eq!(bucket(&result, base + DAY_MS)["users"], 2);
    assert_eq!(bucket(&result, base + DAY_MS)["sessions"], 1);
    assert_eq!(bucket(&result, base + DAY_MS)["turnCount"], 2);
    assert_eq!(bucket(&result, base + DAY_MS)["relayedBytes"], "30");
    assert_eq!(bucket(&result, base + 2 * DAY_MS)["users"], 3);
    assert_eq!(bucket(&result, base + 2 * DAY_MS)["sessions"], 2);
    assert_eq!(bucket(&result, base + 2 * DAY_MS)["relayedBytes"], "0");
    assert_eq!(bucket(&result, base + 3 * DAY_MS)["users"], 2);
    assert_eq!(bucket(&result, base + 4 * DAY_MS)["sessions"], 1);
    let before = store
        .site_usage_trends(&fixture.admin, "30d")
        .await
        .unwrap();
    assert_eq!(store.compact_turn_usage(100).await.unwrap(), 1);
    let after = store
        .site_usage_trends(&fixture.admin, "30d")
        .await
        .unwrap();
    assert_eq!(before["buckets"], after["buckets"]);
    assert_eq!(bucket(&after, base - 4 * DAY_MS)["relayedBytes"], "19");
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn migration_recovers_uuid_and_snapshot_dates_and_defaults_new_creation() {
    let fixture = Fixture::new().await;
    let db = fixture.store.database();
    db.execute_unprepared(include_str!("../src/creation_timestamps_down.sql"))
        .await
        .unwrap();
    fixture.exec("INSERT INTO cp_users(id,name,email,email_verified) VALUES('018cc251-f400-7000-8000-000000000001','Legacy','v7@site-usage.test',true),('legacy-id','Legacy','old@site-usage.test',true)",vec![]).await;
    fixture.exec("INSERT INTO cp_site_audit(source,action,target_user_id,before_value,after_value,occurred_at) VALUES('cli','account.create','legacy-id','{}','{}',1704153600000)", vec![]).await;
    fixture
        .exec("INSERT INTO cp_teams(name) VALUES('Historical')", vec![])
        .await;
    fixture.exec("INSERT INTO cp_billing_profiles(team_id,period_anchor) SELECT id,1704240000000 FROM cp_teams WHERE name='Historical'",vec![]).await;
    fixture
        .exec(
            "INSERT INTO cp_machines(identity_token_hash) VALUES('test-identity')",
            vec![],
        )
        .await;
    fixture.exec("INSERT INTO cp_machine_registrations(team_id,owner_id,name,origin_id,local_machine_id,token_hash,capabilities,machine_id) SELECT t.id,'legacy-id','Legacy','origin','1','test-token','{}',m.id FROM cp_teams t CROSS JOIN cp_machines m WHERE t.name='Historical'",vec![]).await;
    fixture.exec("INSERT INTO cp_sessions(registration_id,session_id,snapshot,snapshot_seq,event_seq,observed_at) SELECT id,'1','{\"session\":{\"createdAt\":\"2024-01-02T01:30:00+01:30\"}}',0,0,1704326400000 FROM cp_machine_registrations",vec![]).await;
    db.execute_unprepared(include_str!("../src/creation_timestamps.sql"))
        .await
        .unwrap();
    let rows = db.query_all_raw(sql("SELECT id,created_at FROM cp_users WHERE id IN ('legacy-id','018cc251-f400-7000-8000-000000000001') ORDER BY id",vec![])).await.unwrap();
    assert_eq!(
        rows[0].try_get::<i64>("", "created_at").unwrap(),
        1704067200000
    );
    assert_eq!(
        rows[1].try_get::<i64>("", "created_at").unwrap(),
        1704153600000
    );
    let row = db.query_one_raw(sql("SELECT s.created_at AS session_at,t.created_at AS team_at FROM cp_sessions s JOIN cp_machine_registrations r ON r.id=s.registration_id JOIN cp_teams t ON t.id=r.team_id",vec![])).await.unwrap().unwrap();
    assert_eq!(row.try_get::<i64>("", "session_at").unwrap(), 1704153600000);
    assert_eq!(row.try_get::<i64>("", "team_at").unwrap(), 1704153600000);
    let before = now_ms();
    let new_user = fixture
        .store
        .verified_user("new@site-usage.test", "New")
        .await
        .unwrap();
    let original = db
        .query_one_raw(sql(
            "SELECT created_at FROM cp_users WHERE id=$1",
            vec![new_user.id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "created_at")
        .unwrap();
    assert!((before..=now_ms()).contains(&original));
    fixture
        .store
        .verified_user("new@site-usage.test", "Renamed")
        .await
        .unwrap();
    let retained = db
        .query_one_raw(sql(
            "SELECT created_at FROM cp_users WHERE id=$1",
            vec![new_user.id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "created_at")
        .unwrap();
    assert_eq!(original, retained);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn relay_uses_daily_cloudflare_counters_and_reports_missing_daily_history() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let base = now_ms().div_euclid(DAY_MS) * DAY_MS - 6 * DAY_MS;
    let team = store
        .create_team(&fixture.admin, "Relay fixture")
        .await
        .unwrap();
    let team_id: i64 = team.id.parse().unwrap();
    fixture.exec("INSERT INTO cp_cloudflare_turn_sources(identifier,team_id,account_id,key_id,analytics_token,expires_at,created_at) VALUES('source',$1,'account','key','fixture-token',$2,$3)", vec![team_id.into(),(base+4*DAY_MS).into(),base.into()]).await;
    // Billing totals cover a different interval and must never be added to days.
    fixture.exec("INSERT INTO cp_cloudflare_turn_usage(identifier,period_start,period_end,expires_at,egress_bytes) VALUES('source',$1,$2,$3,99999)",vec![base.into(),(base+30*DAY_MS).into(),(base+4*DAY_MS).into()]).await;
    fixture.exec("INSERT INTO cp_cloudflare_turn_daily(identifier,day_start,egress_bytes,query_end,collected_at) VALUES('source',$1,7,$2,$2)",vec![(base+DAY_MS).into(),(base+2*DAY_MS).into()]).await;
    fixture.exec("INSERT INTO cp_turn_usage(peer_id,team_id,realm,allocation_id,side,received_bytes,sent_bytes,collected_at) VALUES('retained-peer',$1,'test','allocation','client',0,9007199254740993,$2)",vec![team_id.into(),(base+DAY_MS).into()]).await;
    let result = store.site_usage_trends(&fixture.admin, "7d").await.unwrap();
    assert_eq!(result["relayHistoryIncomplete"], true);
    assert_eq!(
        bucket(&result, base + DAY_MS)["relayedBytes"],
        "9007199254741000"
    );
    assert_eq!(bucket(&result, base + 2 * DAY_MS)["relayedBytes"], "0");
    fixture
        .exec(
            "UPDATE cp_cloudflare_turn_usage SET daily_collected_at=$1",
            vec![now_ms().into()],
        )
        .await;
    // An expired source whose billing period overlaps the chart is not a gap.
    fixture.exec("INSERT INTO cp_cloudflare_turn_usage(identifier,period_start,period_end,expires_at,egress_bytes) VALUES('source',$1,$2,$3,88888)",vec![(base-30*DAY_MS).into(),(base+DAY_MS).into(),(base-DAY_MS).into()]).await;
    let complete = store.site_usage_trends(&fixture.admin, "7d").await.unwrap();
    assert_eq!(complete["relayHistoryIncomplete"], false);
    assert_eq!(complete["buckets"], result["buckets"]);
    fixture.close().await;
}
