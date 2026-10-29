//! Billing facts survive retries and commit atomically with entitlement projections.
use deskfleet_control_store::{
    ControlStore,
    billing::{BillingAnalyticsEvent, SubscriptionProjection},
    now_ms,
};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use std::collections::BTreeMap;

async fn fixture() -> (ControlStore, DatabaseConnection, String, String, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let db = Database::connect(&url).await.unwrap();
    let schema = format!("billing_analytics_{}", uuid::Uuid::new_v4().simple());
    db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let user = store
        .verified_user("owner@analytics.test", "Owner")
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Analytics").await.unwrap();
    (store, db, schema, user.id, team.id)
}

async fn cleanup(store: ControlStore, db: DatabaseConnection, schema: &str) {
    store.close().await.unwrap();
    db.execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    db.close().await.unwrap();
}

fn fact(actor: &str) -> BillingAnalyticsEvent {
    BillingAnalyticsEvent {
        id: "invoice:in_test:paid".into(),
        name: "billing_invoice_paid".into(),
        user_id: Some(actor.into()),
        time: 1_700_000_000_000,
        value: Some(500),
        metadata: BTreeMap::from([("currency".into(), "usd".into())]),
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn billing_analytics_deduplicates_and_retries_with_fenced_delivery_claims() {
    let (store, db, schema, actor, team) = fixture().await;
    let event = fact(&actor);
    store
        .record_billing_analytics(&team, &[event.clone(), event.clone()])
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        store.claim_billing_analytics(),
        store.claim_billing_analytics()
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(usize::from(a.is_some()) + usize::from(b.is_some()), 1);
    let first = a.or(b).unwrap();
    assert_eq!(first.event.value, Some(500));
    assert_eq!(first.event.user_id.as_deref(), Some(actor.as_str()));
    store.finish_billing_analytics(&first, false).await.unwrap();
    assert!(store.claim_billing_analytics().await.unwrap().is_none());
    store
        .database()
        .execute_unprepared("UPDATE cp_billing_analytics SET available_at=0")
        .await
        .unwrap();
    let second = store.claim_billing_analytics().await.unwrap().unwrap();
    assert_ne!(first.claim_token, second.claim_token);
    assert_eq!(
        serde_json::to_value(&first.event).unwrap(),
        serde_json::to_value(&second.event).unwrap()
    );
    store.finish_billing_analytics(&first, true).await.unwrap();
    let row = store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT sent_at,claim_token FROM cp_billing_analytics",
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<Option<i64>>("", "sent_at").unwrap(), None);
    assert_eq!(
        row.try_get::<String>("", "claim_token").unwrap(),
        second.claim_token
    );
    store.finish_billing_analytics(&second, true).await.unwrap();
    store
        .record_billing_analytics(&team, &[event])
        .await
        .unwrap();
    assert!(store.claim_billing_analytics().await.unwrap().is_none());
    cleanup(store, db, &schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn billing_analytics_is_atomic_with_coverage_and_checkout_keeps_authenticated_actor() {
    let (store, db, schema, actor, team) = fixture().await;
    let token = store.claim_billing_operation(&team).await.unwrap().unwrap();
    let attempt = store
        .create_checkout_attempt(
            &team,
            &token,
            &uuid::Uuid::new_v4().to_string(),
            "go",
            "year",
            &actor,
        )
        .await
        .unwrap();
    assert_eq!(attempt.actor_user_id.as_deref(), Some(actor.as_str()));
    let projection = SubscriptionProjection {
        subscription_id: "sub_test".into(),
        status: "active".into(),
        paid_plan: Some("go".into()),
        paid_through: Some(now_ms() + 60_000),
        period_anchor: now_ms(),
        cancel_at_period_end: false,
    };
    assert!(
        store
            .apply_subscription(&team, "stale", &projection, &[fact(&actor)])
            .await
            .is_err()
    );
    assert!(store.claim_billing_analytics().await.unwrap().is_none());
    store
        .apply_subscription(&team, &token, &projection, &[fact(&actor)])
        .await
        .unwrap();
    assert_eq!(
        store.billing_profile(&team).await.unwrap().plan.as_deref(),
        Some("go")
    );
    let queued = store.claim_billing_analytics().await.unwrap().unwrap();
    assert_eq!(queued.event.id, "invoice:in_test:paid");
    // A serialization or insert failure also rolls the billing update back.
    store.database().execute_unprepared("ALTER TABLE cp_billing_analytics ADD CONSTRAINT fixture_reject CHECK (event_id <> 'reject')").await.unwrap();
    let mut invalid = fact(&actor);
    invalid.id = "reject".into();
    let next = SubscriptionProjection {
        paid_plan: Some("pro".into()),
        ..projection
    };
    assert!(
        store
            .apply_subscription(&team, &token, &next, &[invalid])
            .await
            .is_err()
    );
    assert_eq!(
        store.billing_profile(&team).await.unwrap().plan.as_deref(),
        Some("go")
    );
    cleanup(store, db, &schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn checkout_state_and_created_fact_commit_together() {
    let (store, db, schema, actor, team) = fixture().await;
    let token = store.claim_billing_operation(&team).await.unwrap().unwrap();
    let attempt = store
        .create_checkout_attempt(
            &team,
            &token,
            &uuid::Uuid::new_v4().to_string(),
            "go",
            "month",
            &actor,
        )
        .await
        .unwrap();
    store.database().execute_unprepared("ALTER TABLE cp_billing_analytics ADD CONSTRAINT fixture_reject CHECK (event_id <> 'reject')").await.unwrap();
    let mut event = fact(&actor);
    event.id = "reject".into();
    assert!(
        store
            .update_checkout_attempt(
                &team,
                &token,
                &attempt.request_id,
                "cs_test",
                "open",
                &[event.clone()],
            )
            .await
            .is_err()
    );
    let unchanged = store
        .checkout_attempt(&attempt.request_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.status, "pending");
    assert!(unchanged.session_id.is_none());
    assert!(store.claim_billing_analytics().await.unwrap().is_none());
    event.id = format!("checkout:{}", attempt.request_id);
    event.name = "billing_checkout_created".into();
    store
        .update_checkout_attempt(
            &team,
            &token,
            &attempt.request_id,
            "cs_test",
            "open",
            &[event.clone()],
        )
        .await
        .unwrap();
    let saved = store
        .checkout_attempt(&attempt.request_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.status, "open");
    assert_eq!(saved.session_id.as_deref(), Some("cs_test"));
    assert_eq!(
        store
            .claim_billing_analytics()
            .await
            .unwrap()
            .unwrap()
            .event
            .id,
        event.id
    );
    cleanup(store, db, &schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn payment_webhook_replay_preserves_original_failed_attempt() {
    let (store, db, schema, _, _) = fixture().await;
    store
        .receive_payment_event(
            "evt_failed",
            "invoice.payment_failed",
            "in_test",
            Some(1000),
            Some(2),
        )
        .await
        .unwrap();
    store
        .receive_payment_event(
            "evt_failed",
            "invoice.payment_failed",
            "in_test",
            Some(2000),
            Some(3),
        )
        .await
        .unwrap();
    let event = store.claim_payment_event().await.unwrap().unwrap();
    assert_eq!(event.occurred_at, Some(1000));
    assert_eq!(event.payment_attempt, Some(2));
    cleanup(store, db, &schema).await;
}
