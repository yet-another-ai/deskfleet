//! Immutable hosted usage and soft admission at the Team's billing boundary.
use deskfleet_control_store::{
    ControlStore, Error,
    billing::{CloudTokenEvent, Plan},
};

use sea_orm::{ConnectionTrait, Database};

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn cloud_token_events_deduplicate_and_meter_the_source_billing_period() {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("cloud_tokens_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap()
        .with_hosted_mode(true);
    let email = format!("cloud-tokens-{}@fixture.test", uuid::Uuid::new_v4());
    let owner = store.verified_user(&email, "Owner").await.unwrap();
    let team = store.create_team(&owner.id, "Cloud test").await.unwrap().id;
    let other = store
        .create_team(&owner.id, "Other cloud test")
        .await
        .unwrap()
        .id;
    store.grant_site_admin(&owner.id).await.unwrap();
    let fresh = store.cloud_token_period(&team).await.unwrap();
    assert_eq!(fresh.included_tokens, Some(0));
    assert!(!fresh.admitted);
    for (plan, tokens) in [(Plan::Free, 10), (Plan::Go, 15), (Plan::Pro, 75)] {
        let mut limits = store.plan_limits(plan).await.unwrap();
        limits.super_agent_tokens = Some(tokens);
        store
            .update_plan_limits(&owner.id, plan, limits)
            .await
            .unwrap();
    }
    let period = store.cloud_token_period(&team).await.unwrap();
    assert!(period.admitted);
    assert_eq!(period.plan, Plan::Free);
    assert_eq!(period.included_tokens, Some(10));
    assert_eq!(period.used_tokens, 0);
    let ms = |value: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis()
    };
    let event = CloudTokenEvent {
        session_id: "root".into(),
        line: 5,
        index: 1,
        occurred_at: ms(&period.start),
        model: None,
        input_tokens: 7,
        output_tokens: 3,
        cached_read_tokens: Some(4),
        cached_write_tokens: Some(1),
    };
    let (first, retry) = tokio::join!(
        store.record_cloud_token_usage(&team, &event),
        store.record_cloud_token_usage(&team, &event),
    );
    assert_ne!(first.unwrap(), retry.unwrap());
    for (index, occurred_at) in [(0, ms(&period.start) - 1), (2, ms(&period.end))] {
        assert!(
            store
                .record_cloud_token_usage(
                    &team,
                    &CloudTokenEvent {
                        index,
                        occurred_at,
                        ..event.clone()
                    }
                )
                .await
                .unwrap()
        );
    }
    let period = store.cloud_token_period(&team).await.unwrap();
    assert_eq!(period.used_tokens, 10);
    assert!(!period.admitted);
    assert!(matches!(
        store
            .record_cloud_token_usage(
                &team,
                &CloudTokenEvent {
                    output_tokens: 4,
                    ..event.clone()
                }
            )
            .await,
        Err(Error::Conflict("cloud_token_event_conflict"))
    ));
    assert!(matches!(
        store
            .record_cloud_token_usage(
                &team,
                &CloudTokenEvent {
                    input_tokens: -1,
                    ..event.clone()
                }
            )
            .await,
        Err(Error::Invalid(_))
    ));
    // A previously admitted turn may still finish and exceed its allowance.
    assert!(
        store
            .record_cloud_token_usage(&team, &CloudTokenEvent { line: 7, ..event })
            .await
            .unwrap()
    );
    assert_eq!(
        store.cloud_token_period(&team).await.unwrap().used_tokens,
        20
    );
    for (plan, included, admitted) in [(Plan::Pro, 75, true), (Plan::Go, 15, false)] {
        store
            .set_manual_grant(
                &owner.id,
                &team,
                Some(plan.as_str()),
                None,
                "test member allowance",
            )
            .await
            .unwrap();
        let changed = store.cloud_token_period(&team).await.unwrap();
        assert_eq!(changed.plan, plan);
        assert_eq!(changed.included_tokens, Some(included));
        assert_eq!(changed.used_tokens, 20);
        assert_eq!(changed.start, period.start);
        assert_eq!(changed.admitted, admitted);
    }
    let mut go = store.plan_limits(Plan::Go).await.unwrap();
    go.super_agent_tokens = None;
    store
        .update_plan_limits(&owner.id, Plan::Go, go)
        .await
        .unwrap();
    let upgraded = store.cloud_token_period(&team).await.unwrap();
    assert_eq!(upgraded.included_tokens, None);
    assert_eq!(upgraded.used_tokens, 20);
    assert!(upgraded.admitted);
    let other = store.cloud_token_period(&other).await.unwrap();
    assert_eq!(other.used_tokens, 0);
    assert_eq!(other.included_tokens, Some(10));
    let unlimited = store
        .clone()
        .with_hosted_mode(false)
        .cloud_token_period(&team)
        .await
        .unwrap();
    assert_eq!(unlimited.plan, Plan::SelfHosted);
    assert_eq!(unlimited.used_tokens, 20);
    assert_eq!(unlimited.included_tokens, None);
    assert!(unlimited.admitted);
    store.close().await.unwrap();
    admin
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn delivery_wakes_preserve_the_active_meter_claim_and_committed_cursor() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let db = Database::connect(&url).await.unwrap();
    let schema = format!("cloud_meter_{}", uuid::Uuid::new_v4().simple());
    db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let owner = store
        .verified_user("meter@example.test", "Owner")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Team").await.unwrap().id;
    store.bind_cloud_session(&team, "s").await.unwrap();
    store.wake_cloud_meter(&team, "s").await.unwrap();
    let first = store.claim_cloud_meter(30_000).await.unwrap().unwrap();
    store.wake_cloud_meter(&team, "s").await.unwrap();
    store.wake_cloud_meter(&team, "s").await.unwrap();
    assert!(store.claim_cloud_meter(30_000).await.unwrap().is_none());
    store.finish_cloud_meter(&first, 42, None).await.unwrap();
    let expired = store.claim_cloud_meter(0).await.unwrap().unwrap();
    assert_eq!(expired.next_line, 42);
    let recovered = store.claim_cloud_meter(30_000).await.unwrap().unwrap();
    store.finish_cloud_meter(&expired, 50, None).await.unwrap();
    store
        .finish_cloud_meter(&recovered, 43, None)
        .await
        .unwrap();
    assert!(store.claim_cloud_meter(30_000).await.unwrap().is_none());
    store.wake_cloud_meter(&team, "s").await.unwrap();
    assert_eq!(
        store
            .claim_cloud_meter(30_000)
            .await
            .unwrap()
            .unwrap()
            .next_line,
        43
    );
    store.close().await.unwrap();
    db.execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
}
