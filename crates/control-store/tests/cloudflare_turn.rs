//! Private provider credentials and replayable aggregate metering against PostgreSQL.
use deskfleet_control_store::{ControlStore, Error, billing::RelayDeniedReason, now_ms};
use deskfleet_protocol::control::{CloudflareTurnSettingsUpdate, TurnSettings};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};

fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

struct Fixture {
    store: ControlStore,
    db: DatabaseConnection,
    schema: String,
    url: String,
    admin: String,
    team: String,
}

impl Fixture {
    async fn new() -> Self {
        let base = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let db = Database::connect(&base).await.unwrap();
        let schema = format!("cloudflare_turn_{}", uuid::Uuid::new_v4().simple());
        db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if base.contains('?') { '&' } else { '?' };
        let url = format!("{base}{separator}options=-csearch_path%3D{schema}");
        let store = ControlStore::connect(&url)
            .await
            .unwrap()
            .with_hosted_mode(true);
        store.seed_turn_settings(&[]).await.unwrap();
        let admin = store
            .verified_user("owner@cloudflare.test", "Owner")
            .await
            .unwrap()
            .id;
        store.grant_site_admin(&admin).await.unwrap();
        let team = store.create_team(&admin, "Cloudflare").await.unwrap().id;
        store.billing_profile(&team).await.unwrap();
        store
            .database()
            .execute_raw(sql(
                "UPDATE cp_billing_profiles SET plan='go',paid_through=$2 WHERE team_id=$1",
                vec![
                    team.parse::<i64>().unwrap().into(),
                    (now_ms() + 86_400_000).into(),
                ],
            ))
            .await
            .unwrap();
        Self {
            store,
            db,
            schema,
            url,
            admin,
            team,
        }
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

fn update() -> CloudflareTurnSettingsUpdate {
    CloudflareTurnSettingsUpdate {
        enabled: true,
        account_id: "a".repeat(32),
        key_id: "b".repeat(32),
        api_token: Some("api-private-token".into()),
        analytics_token: Some("analytics-private-token".into()),
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn admin_billing_reports_freshness_for_each_team() {
    let f = Fixture::new().await;
    let healthy_team = f.store.create_team(&f.admin, "Healthy").await.unwrap().id;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    let config = f.store.cloudflare_turn_config().await.unwrap();
    f.store
        .prepare_cloudflare_turn_usage(&f.team, &config, now_ms() + 3_600_000)
        .await
        .unwrap();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_sources SET created_at=$2 WHERE team_id=$1",
            vec![
                f.team.parse::<i64>().unwrap().into(),
                (now_ms() - 180_000).into(),
            ],
        ))
        .await
        .unwrap();

    let page = f
        .store
        .admin_billing_teams(&f.admin, None, None, 10)
        .await
        .unwrap();
    for team in [&f.team, &healthy_team] {
        let entry = page
            .teams
            .iter()
            .find(|value| value["id"] == *team)
            .unwrap();
        let summary = f.store.billing_summary(team).await.unwrap();
        assert_eq!(entry["billing"]["metering"], summary["metering"]);
    }
    let stale = page
        .teams
        .iter()
        .find(|value| value["id"] == f.team)
        .unwrap();
    let healthy = page
        .teams
        .iter()
        .find(|value| value["id"] == healthy_team)
        .unwrap();
    assert_eq!(stale["billing"]["metering"]["fresh"], false);
    assert_eq!(healthy["billing"]["metering"]["fresh"], true);
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn rollover_uses_only_recent_contiguous_previous_usage_until_the_new_snapshot_arrives() {
    let f = Fixture::new().await;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    let now = now_ms();
    let start = now - 20_000;
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_billing_profiles SET period_anchor=$2 WHERE team_id=$1",
            vec![f.team.parse::<i64>().unwrap().into(), start.into()],
        ))
        .await
        .unwrap();
    let profile = f.store.billing_profile(&f.team).await.unwrap();
    let (period_start, _) = deskfleet_control_store::billing::period_at(profile.period_anchor, now);
    assert_eq!(period_start, start);
    let config = f.store.cloudflare_turn_config().await.unwrap();
    let identifier = f
        .store
        .prepare_cloudflare_turn_usage(&f.team, &config, now + 3_600_000)
        .await
        .unwrap();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_sources SET created_at=$2 WHERE identifier=$1",
            vec![identifier.as_str().into(), (now - 180_000).into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );

    // The immediately preceding period was healthy at the boundary, while the
    // current period's row still has no collector result.
    f.store.database().execute_raw(sql(
        "INSERT INTO cp_cloudflare_turn_usage(identifier,period_start,period_end,expires_at,query_end,collected_at) VALUES($1,$2,$3,$3,$4,$5)",
        vec![identifier.as_str().into(), (start - 2_592_000_000_i64).into(), start.into(), (start - 1000).into(), (now - 1000).into()],
    )).await.unwrap();
    assert!(f.store.relay_allowed(&f.team).await.unwrap());
    assert_eq!(
        f.store.billing_summary(&f.team).await.unwrap()["metering"]["fresh"],
        true
    );
    let page = f
        .store
        .admin_billing_teams(&f.admin, None, None, 10)
        .await
        .unwrap();
    let team = page.teams.iter().find(|team| team["id"] == f.team).unwrap();
    assert_eq!(team["billing"]["metering"]["fresh"], true);

    f.store.database().execute_raw(sql(
        "UPDATE cp_cloudflare_turn_usage SET collected_at=$3 WHERE identifier=$1 AND period_end=$2",
        vec![identifier.as_str().into(), start.into(), (now - 121_000).into()],
    )).await.unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    // A recently queried but old-ended backfill must not stand in for recent usage.
    f.store.database().execute_raw(sql(
        "UPDATE cp_cloudflare_turn_usage SET collected_at=$3,query_end=$4 WHERE identifier=$1 AND period_end=$2",
        vec![identifier.as_str().into(), start.into(), (now - 1000).into(), (start - 120_001).into()],
    )).await.unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    // A different boundary is not a normal rollover, including a changed anchor.
    f.store.database().execute_raw(sql(
        "UPDATE cp_cloudflare_turn_usage SET period_end=$3,query_end=$4 WHERE identifier=$1 AND period_end=$2",
        vec![identifier.as_str().into(), start.into(), (start - 1).into(), (start - 1000).into()],
    )).await.unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );

    // Once the current snapshot arrives it is authoritative, including quota exhaustion.
    f.store.database().execute_raw(sql(
        "UPDATE cp_cloudflare_turn_usage SET collected_at=$3,query_end=$3,egress_bytes=2147483648 WHERE identifier=$1 AND period_start=$2",
        vec![identifier.as_str().into(), start.into(), now_ms().into()],
    )).await.unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::TurnQuotaExhausted)
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn credentials_are_private_audited_preserved_and_explicitly_clearable() {
    let f = Fixture::new().await;
    let member = f
        .store
        .verified_user("member@cloudflare.test", "Member")
        .await
        .unwrap();
    assert!(matches!(
        f.store.read_cloudflare_turn_settings(&member.id).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        f.store
            .update_cloudflare_turn_settings(&member.id, &update())
            .await,
        Err(Error::Forbidden)
    ));
    let saved = f
        .store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    assert!(saved.api_token_configured && saved.analytics_token_configured);
    let mut input = update();
    input.api_token = None;
    input.analytics_token = None;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &input)
        .await
        .unwrap();
    let restarted = ControlStore::connect(&f.url).await.unwrap();
    let config = restarted.cloudflare_turn_config().await.unwrap();
    assert_eq!(config.api_token, "api-private-token");
    assert_eq!(config.analytics_token, "analytics-private-token");
    let audit: serde_json::Value = f.store.database().query_one_raw(sql("SELECT jsonb_agg(to_jsonb(a)) AS value FROM cp_site_audit a WHERE action='cloudflare.turn.settings.update'",vec![])).await.unwrap().unwrap().try_get("","value").unwrap();
    let text = audit.to_string();
    assert!(!text.contains("api-private-token") && !text.contains("analytics-private-token"));
    assert!(
        !serde_json::to_string(&saved)
            .unwrap()
            .contains("private-token")
    );
    input.api_token = Some(String::new());
    assert!(matches!(
        f.store
            .update_cloudflare_turn_settings(&f.admin, &input)
            .await,
        Err(Error::Invalid(_))
    ));
    input.enabled = false;
    let cleared = f
        .store
        .update_cloudflare_turn_settings(&f.admin, &input)
        .await
        .unwrap();
    assert!(!cleared.api_token_configured && cleared.analytics_token_configured);
    restarted.close().await.unwrap();
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn snapshots_replace_replays_revisions_and_remain_collectable_after_disable() {
    let f = Fixture::new().await;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    let config = f.store.cloudflare_turn_config().await.unwrap();
    let now = now_ms();
    let identifier = f
        .store
        .prepare_cloudflare_turn_usage(&f.team, &config, now + 86_400_000)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .prepare_cloudflare_turn_usage(&f.team, &config, now + 86_400_000)
            .await
            .unwrap(),
        identifier
    );
    let second_team = f.store.create_team(&f.admin, "Other").await.unwrap();
    assert_ne!(
        f.store
            .prepare_cloudflare_turn_usage(&second_team.id, &config, now + 86_400_000)
            .await
            .unwrap(),
        identifier
    );
    assert!(
        f.store
            .claim_cloudflare_turn_collector("collector")
            .await
            .unwrap()
    );
    assert!(
        !f.store
            .claim_cloudflare_turn_collector("other")
            .await
            .unwrap()
    );
    // Reusing a source later must not reopen an already finalized historical window.
    f.store.database().execute_raw(sql(
        "INSERT INTO cp_cloudflare_turn_usage(identifier,period_start,period_end,expires_at,query_end,collected_at,last_attempt_at) VALUES($1,$2,$3,$4,$4,$5,$5)",
        vec![identifier.as_str().into(),(now-60*86_400_000_i64).into(),(now-30*86_400_000_i64).into(),(now-40*86_400_000_i64).into(),(now-40*86_400_000_i64+300000).into()],
    )).await.unwrap();
    let queries = f
        .store
        .cloudflare_turn_usage_queries(now + 1000, 10)
        .await
        .unwrap();
    assert_eq!(queries.len(), 2);
    let query = queries.iter().find(|q| q.team_id == f.team).unwrap();
    assert!(
        !f.store
            .save_cloudflare_turn_usage(query, 123, "other")
            .await
            .unwrap()
    );
    assert!(
        f.store
            .save_cloudflare_turn_usage(query, 123, "collector")
            .await
            .unwrap()
    );
    f.store
        .save_cloudflare_turn_usage(query, 123, "collector")
        .await
        .unwrap();
    assert_eq!(
        f.store.billing_summary(&f.team).await.unwrap()["usage"]["relayedBytes"],
        "123"
    );
    f.store
        .save_cloudflare_turn_usage(query, 100, "collector")
        .await
        .unwrap();
    assert_eq!(
        f.store.billing_summary(&f.team).await.unwrap()["usage"]["relayedBytes"],
        "100"
    );
    f.store
        .database()
        .execute_raw(sql(
            "INSERT INTO cp_turn_usage_minutes(team_id,minute_at,sent_bytes) VALUES($1,$2,7)",
            vec![
                f.team.parse::<i64>().unwrap().into(),
                ((now / 60_000 + 1) * 60_000).into(),
            ],
        ))
        .await
        .unwrap();
    assert_eq!(
        f.store.billing_summary(&f.team).await.unwrap()["usage"]["relayedBytes"],
        "107"
    );
    let mut disabled = update();
    disabled.enabled = false;
    disabled.analytics_token = Some(String::new());
    f.store
        .update_cloudflare_turn_settings(&f.admin, &disabled)
        .await
        .unwrap();
    let restarted = ControlStore::connect(&f.url).await.unwrap();
    // Saves use wall-clock timestamps; allow the retry interval after those writes.
    let due = restarted
        .cloudflare_turn_usage_queries(now_ms() + 61_000, 10)
        .await
        .unwrap();
    let retained = due.iter().find(|q| q.identifier == identifier).unwrap();
    assert_eq!(retained.analytics_token, "analytics-private-token");
    assert_eq!(retained.period_start, query.period_start);
    assert_eq!(retained.period_end, query.period_end);
    let summaries = f
        .store
        .admin_billing_teams(&f.admin, None, None, 10)
        .await
        .unwrap();
    assert_eq!(
        summaries
            .teams
            .iter()
            .find(|team| team["id"] == f.team)
            .unwrap()["billing"]["usage"]["relayedBytes"],
        "107"
    );
    restarted.close().await.unwrap();
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn cloudflare_only_bootstraps_and_mixed_relays_require_both_meters() {
    let f = Fixture::new().await;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    assert!(f.store.relay_allowed(&f.team).await.unwrap());
    let config = f.store.cloudflare_turn_config().await.unwrap();
    f.store
        .prepare_cloudflare_turn_usage(&f.team, &config, now_ms() + 86_400_000)
        .await
        .unwrap();
    assert!(f.store.relay_allowed(&f.team).await.unwrap());
    f.store
        .database()
        .execute_unprepared("UPDATE cp_cloudflare_turn_sources SET created_at=created_at-180000")
        .await
        .unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    assert!(
        f.store
            .claim_cloudflare_turn_collector("collector")
            .await
            .unwrap()
    );
    let query = f
        .store
        .cloudflare_turn_usage_queries(now_ms() + 1000, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.store
        .save_cloudflare_turn_usage(&query, 99, "collector")
        .await
        .unwrap();
    assert!(f.store.relay_allowed(&f.team).await.unwrap());
    f.store
        .update_turn_settings(
            &f.admin,
            &TurnSettings {
                urls: vec!["turn:relay.test".into()],
                allow_team_servers: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    assert!(f.store.claim_turn_collector("redis").await.unwrap());
    assert!(f.store.heartbeat_turn_collector("redis").await.unwrap());
    assert!(f.store.relay_allowed(&f.team).await.unwrap());
    f.store
        .save_cloudflare_turn_usage(&query, 2_147_483_648, "collector")
        .await
        .unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::TurnQuotaExhausted)
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn crossing_month_boundaries_keeps_distinct_periods_and_migration_reverts() {
    let f = Fixture::new().await;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    let now = now_ms();
    let boundary = chrono::DateTime::from_timestamp_millis(now + 10_000).unwrap();
    let anchor = boundary
        .checked_sub_months(chrono::Months::new(1))
        .unwrap()
        .timestamp_millis();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_billing_profiles SET period_anchor=$2 WHERE team_id=$1",
            vec![f.team.parse::<i64>().unwrap().into(), anchor.into()],
        ))
        .await
        .unwrap();
    let config = f.store.cloudflare_turn_config().await.unwrap();
    f.store
        .prepare_cloudflare_turn_usage(&f.team, &config, now + 86_400_000)
        .await
        .unwrap();
    let queries = f
        .store
        .cloudflare_turn_usage_queries(now + 20_000, 10)
        .await
        .unwrap();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0].period_end, queries[1].period_start);
    assert!(
        f.store
            .claim_cloudflare_turn_collector("collector")
            .await
            .unwrap()
    );
    for (query, bytes) in queries.iter().zip([10_i64, 20]) {
        f.store
            .save_cloudflare_turn_usage(query, bytes, "collector")
            .await
            .unwrap();
        let total: String = f
            .store
            .database()
            .query_one_raw(sql(
                "SELECT cp_turn_sent_bytes($1,$2,$3)::text AS bytes",
                vec![
                    f.team.parse::<i64>().unwrap().into(),
                    query.period_start.into(),
                    query.period_end.into(),
                ],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "bytes")
            .unwrap();
        assert_eq!(total, bytes.to_string());
    }
    f.store
        .database()
        .execute_unprepared(include_str!("../src/cloudflare_turn_down.sql"))
        .await
        .unwrap();
    f.store
        .database()
        .execute_unprepared("DELETE FROM cp_migrations WHERE version=23")
        .await
        .unwrap();
    deskfleet_control_store::schema::migrate(f.store.database())
        .await
        .unwrap();
    assert!(!f.store.cloudflare_turn_config().await.unwrap().enabled);
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn failures_yield_to_other_teams_and_token_repair_applies_without_new_credentials() {
    let f = Fixture::new().await;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    let config = f.store.cloudflare_turn_config().await.unwrap();
    let second = f.store.create_team(&f.admin, "Other").await.unwrap();
    for team in [&f.team, &second.id] {
        f.store
            .prepare_cloudflare_turn_usage(team, &config, now_ms() + 86_400_000)
            .await
            .unwrap();
    }
    f.store
        .claim_cloudflare_turn_collector("collector")
        .await
        .unwrap();
    let failed = f
        .store
        .cloudflare_turn_usage_queries(now_ms() + 1000, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        !f.store
            .fail_cloudflare_turn_usage(&failed, "other")
            .await
            .unwrap()
    );
    assert!(
        f.store
            .fail_cloudflare_turn_usage(&failed, "collector")
            .await
            .unwrap()
    );
    let next = f
        .store
        .cloudflare_turn_usage_queries(now_ms() + 1000, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_ne!(failed.identifier, next.identifier);
    let mut repaired = update();
    repaired.analytics_token = Some("repaired-analytics-token".into());
    f.store
        .update_cloudflare_turn_settings(&f.admin, &repaired)
        .await
        .unwrap();
    let next = f
        .store
        .cloudflare_turn_usage_queries(now_ms() + 1000, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(next.analytics_token, "repaired-analytics-token");
    f.store
        .database()
        .execute_unprepared("UPDATE cp_cloudflare_turn_sources SET created_at=created_at-180000")
        .await
        .unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn replacement_subscription_requeries_finalized_usage_without_new_issuance() {
    let f = Fixture::new().await;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    let now = now_ms();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_billing_profiles SET period_anchor=$2 WHERE team_id=$1",
            vec![
                f.team.parse::<i64>().unwrap().into(),
                (now - 3_600_000).into(),
            ],
        ))
        .await
        .unwrap();
    let config = f.store.cloudflare_turn_config().await.unwrap();
    f.store
        .prepare_cloudflare_turn_usage(&f.team, &config, now + 60_000)
        .await
        .unwrap();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_sources SET expires_at=$1",
            vec![(now - 600_000).into()],
        ))
        .await
        .unwrap();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_usage SET expires_at=$1",
            vec![(now - 600_000).into()],
        ))
        .await
        .unwrap();
    f.store
        .claim_cloudflare_turn_collector("collector")
        .await
        .unwrap();
    let first = f
        .store
        .cloudflare_turn_usage_queries(now + 1000, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.store
        .save_cloudflare_turn_usage(&first, 100, "collector")
        .await
        .unwrap();
    assert!(
        f.store
            .cloudflare_turn_usage_queries(now + 61_000, 10)
            .await
            .unwrap()
            .is_empty()
    );
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_billing_profiles SET period_anchor=$2 WHERE team_id=$1",
            vec![
                f.team.parse::<i64>().unwrap().into(),
                (now - 7_200_000).into(),
            ],
        ))
        .await
        .unwrap();
    let revised = f
        .store
        .cloudflare_turn_usage_queries(now + 1000, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(revised.identifier, first.identifier);
    assert_ne!(revised.period_start, first.period_start);
    assert_eq!(revised.analytics_token, "analytics-private-token");
    f.store
        .save_cloudflare_turn_usage(&revised, 105, "collector")
        .await
        .unwrap();
    assert_eq!(
        f.store.billing_summary(&f.team).await.unwrap()["usage"]["relayedBytes"],
        "105"
    );
    assert!(
        f.store
            .cloudflare_turn_usage_queries(now + 33 * 86_400_000, 10)
            .await
            .unwrap()
            .is_empty()
    );
    let retained: String = f
        .store
        .database()
        .query_one_raw(sql(
            "SELECT analytics_token FROM cp_cloudflare_turn_sources WHERE identifier=$1",
            vec![first.identifier.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "analytics_token")
        .unwrap();
    assert!(retained.is_empty());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn expired_unsettled_usage_still_blocks_grants_and_cannot_reset_bootstrap_grace() {
    let f = Fixture::new().await;
    f.store
        .update_cloudflare_turn_settings(&f.admin, &update())
        .await
        .unwrap();
    let now = now_ms();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_billing_profiles SET period_anchor=$2 WHERE team_id=$1",
            vec![
                f.team.parse::<i64>().unwrap().into(),
                (now - 3_600_000).into(),
            ],
        ))
        .await
        .unwrap();
    let config = f.store.cloudflare_turn_config().await.unwrap();
    f.store
        .prepare_cloudflare_turn_usage(&f.team, &config, now + 60_000)
        .await
        .unwrap();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_sources SET expires_at=$1,created_at=$2",
            vec![(now - 600_000).into(), (now - 3_600_000).into()],
        ))
        .await
        .unwrap();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_usage SET expires_at=$1",
            vec![(now - 600_000).into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    // Even a caller that directly registers a credential cannot renew the grace.
    f.store
        .prepare_cloudflare_turn_usage(&f.team, &config, now + 60_000)
        .await
        .unwrap();
    assert_eq!(
        f.store.relay_denied_reason(&f.team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_sources SET expires_at=$1",
            vec![(now - 600_000).into()],
        ))
        .await
        .unwrap();
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_usage SET expires_at=$1",
            vec![(now - 600_000).into()],
        ))
        .await
        .unwrap();
    f.store
        .claim_cloudflare_turn_collector("collector")
        .await
        .unwrap();
    let query = f
        .store
        .cloudflare_turn_usage_queries(now + 1000, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.store
        .save_cloudflare_turn_usage(&query, 100, "collector")
        .await
        .unwrap();
    assert!(f.store.relay_allowed(&f.team).await.unwrap());
    f.store
        .database()
        .execute_raw(sql(
            "UPDATE cp_cloudflare_turn_usage SET collected_at=$1",
            vec![(now - 180_000).into()],
        ))
        .await
        .unwrap();
    // A completed final query needs no periodic heartbeat after its source expires.
    assert!(f.store.relay_allowed(&f.team).await.unwrap());
    f.close().await;
}
