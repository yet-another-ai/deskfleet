//! PostgreSQL behavior: atomic allowances, durable lifecycle admission, and payment fencing.
use deskfleet_control_store::{
    ControlStore, TurnUsage, TurnUsageSide,
    billing::{RelayDeniedReason, SubscriptionProjection},
    now_ms, timestamp,
};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::json;

// Only tests that mutate the collector singleton need to share this guard.
static COLLECTOR_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn fixture() -> (ControlStore, String, String, String) {
    let store =
        ControlStore::connect(&std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL"))
            .await
            .unwrap()
            .with_hosted_mode(true);
    let user = store
        .verified_user(
            &format!("billing-{}@example.test", uuid::Uuid::new_v4()),
            "Owner",
        )
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Billing test").await.unwrap();
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
    (store, user.id, team.id, machine.id)
}
async fn execute(store: &ControlStore, query: &str, values: Vec<sea_orm::Value>) {
    store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            query,
            values,
        ))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn free_seats_and_session_admissions_are_atomic_and_generation_safe() {
    let (store, owner, team, machine) = fixture().await;
    let mut users = Vec::new();
    let mut invites = Vec::new();
    for _ in 0..3 {
        let email = format!("member-{}@example.test", uuid::Uuid::new_v4());
        let user = store.verified_user(&email, "Member").await.unwrap();
        let invite = store.invite(&owner, &team, &email, "member").await.unwrap();
        users.push(user.id);
        invites.push(invite["token"].as_str().unwrap().to_owned());
    }
    store.accept_invite(&users[0], &invites[0]).await.unwrap();
    let (left, right) = tokio::join!(
        store.accept_invite(&users[1], &invites[1]),
        store.accept_invite(&users[2], &invites[2])
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    assert_eq!(store.members(&owner, &team).await.unwrap().len(), 3);
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let a = store
        .reserve_session(&machine, &first, "create", None)
        .await
        .unwrap();
    assert_eq!(
        a,
        store
            .reserve_session(&machine, &first, "create", None)
            .await
            .unwrap()
    );
    store
        .confirm_session_admission(&machine, &first, &first, "1")
        .await
        .unwrap();
    store
        .reserve_session(&machine, &second, "create", None)
        .await
        .unwrap();
    let third = uuid::Uuid::new_v4().to_string();
    let fourth = uuid::Uuid::new_v4().to_string();
    let (left, right) = tokio::join!(
        store.reserve_session(&machine, &third, "fork", None),
        store.reserve_session(&machine, &fourth, "create", None)
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    let active = if left.is_ok() { &third } else { &fourth };
    store
        .cancel_session_admission(&machine, active, active)
        .await
        .unwrap();
    store
        .release_session_admission(&machine, "1", &first)
        .await
        .unwrap();
    assert_eq!(
        store
            .confirm_session_admission(&machine, &first, &first, "1")
            .await
            .unwrap()["status"],
        "released"
    );
    let restored = uuid::Uuid::new_v4().to_string();
    store
        .reserve_session(&machine, &restored, "restore", Some("1"))
        .await
        .unwrap();
    store
        .confirm_session_admission(&machine, &restored, &restored, "1")
        .await
        .unwrap();
    store
        .release_session_admission(&machine, "1", &first)
        .await
        .unwrap();
    assert_eq!(
        store.team_usage(&owner, &team).await.unwrap()["activeSessionCount"],
        2
    );
    assert!(
        store
            .cancel_session_admission(&machine, &restored, &restored)
            .await
            .is_err()
    );
    execute(
        &store,
        "UPDATE cp_session_admissions SET created_at=0 WHERE id=$1",
        vec![second.into()],
    )
    .await;
    assert_eq!(
        store.session_admissions(&machine).await.unwrap().len(),
        2,
        "unknown outcomes never age out"
    );
    store.revoke_machine(&owner, &machine).await.unwrap();
    assert!(store.session_admissions(&machine).await.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn paid_deadlines_override_and_turn_usage_preserve_independent_state() {
    let _collector_guard = COLLECTOR_TEST_LOCK.lock().await;
    let (store, owner, team, machine) = fixture().await;
    assert!(!store.relay_allowed(&team).await.unwrap());
    assert_eq!(
        store.relay_denied_reason(&team).await.unwrap(),
        Some(RelayDeniedReason::FreePlan)
    );
    let operator = store
        .verified_user(
            &format!("operator-{}@example.test", uuid::Uuid::new_v4()),
            "Operator",
        )
        .await
        .unwrap();
    store.grant_site_admin(&operator.id).await.unwrap();
    let billing_team = store.create_team(&owner, "Paid empty Team").await.unwrap();
    let billing_lease = store
        .claim_billing_operation(&billing_team.id)
        .await
        .unwrap()
        .unwrap();
    store
        .billing_customer(
            &billing_team.id,
            &billing_lease,
            &format!("cus_{}", uuid::Uuid::new_v4()),
        )
        .await
        .unwrap();
    store
        .release_billing_operation(&billing_team.id, &billing_lease)
        .await
        .unwrap();
    assert!(matches!(
        store.delete_team(&owner, &billing_team.id).await,
        Err(deskfleet_control_store::Error::Conflict(
            "team owns billing records and cannot be deleted"
        ))
    ));
    assert!(
        store
            .billing_profile(&billing_team.id)
            .await
            .unwrap()
            .customer_id
            .is_some()
    );
    assert!(store.team_role(&operator.id, &team).await.is_err());
    let lease = store.claim_billing_operation(&team).await.unwrap().unwrap();
    assert!(
        store
            .claim_billing_operation(&team)
            .await
            .unwrap()
            .is_none()
    );
    let customer = format!("cus_{}", uuid::Uuid::new_v4());
    let subscription = format!("sub_{}", uuid::Uuid::new_v4());
    store
        .billing_customer(&team, &lease, &customer)
        .await
        .unwrap();
    let now = now_ms();
    let projection = SubscriptionProjection {
        subscription_id: subscription,
        status: "active".into(),
        paid_plan: Some("go".into()),
        paid_through: Some(now + 86_400_000),
        period_anchor: now - 1000,
        cancel_at_period_end: false,
    };
    store
        .apply_subscription(&team, &lease, &projection, &[])
        .await
        .unwrap();
    store
        .release_billing_operation(&team, &lease)
        .await
        .unwrap();
    for last_seen in [None, Some(now_ms() - 60_000)] {
        execute(
            &store,
            "UPDATE cp_turn_collector SET last_seen_at=$1 WHERE singleton",
            vec![last_seen.into()],
        )
        .await;
        assert_eq!(
            store.relay_denied_reason(&team).await.unwrap(),
            Some(RelayDeniedReason::MeteringUnavailable)
        );
        assert_eq!(
            store.billing_summary(&team).await.unwrap()["metering"]["fresh"],
            false
        );
    }
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=$1 WHERE singleton",
        vec![now_ms().into()],
    )
    .await;
    assert!(store.relay_allowed(&team).await.unwrap());
    let session = store.new_session(&owner).await.unwrap();
    let auth = store
        .authenticate(session["token"].as_str().unwrap())
        .await
        .unwrap();
    let m = store.machine(&machine).await.unwrap();
    let peer = uuid::Uuid::new_v4().to_string();
    let authorization = PeerAuthorization {
        peer_id: peer.clone(),
        server_id: "https://test.invalid".into(),
        team_id: team.clone(),
        actor: PeerActor {
            kind: "user".into(),
            user_id: owner.clone(),
            device_id: auth.device_id,
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: machine,
            origin_id: m.origin_id,
            local_machine_id: "1".into(),
        },
        purpose: "agent".into(),
        transport: deskfleet_protocol::control::PeerTransport::Webrtc,
        actions: vec!["agent:read".into()],
        issued_at: timestamp(now),
        expires_at: timestamp(now + 60_000),
    };
    store
        .save_peer(&authorization, &auth.id, now + 60_000)
        .await
        .unwrap();
    store.save_peer_relay_decision(&peer, true).await.unwrap();
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=$1,gap_since=$1 WHERE singleton",
        vec![(now_ms() - 60_000).into()],
    )
    .await;
    assert!(!store.relay_allowed(&team).await.unwrap());
    assert!(store.peer_relay_decision(&peer).await.unwrap());
    // A new heartbeat restores admission; the historical collection gap remains visible.
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=$1 WHERE singleton",
        vec![now_ms().into()],
    )
    .await;
    assert!(store.relay_allowed(&team).await.unwrap());
    let summary = store.billing_summary(&team).await.unwrap();
    assert_eq!(summary["metering"]["fresh"], true);
    assert!(summary["metering"]["gapSince"].is_string());
    let mut traffic = TurnUsage {
        peer_id: peer,
        realm: "test".into(),
        allocation_id: "allocation".into(),
        side: TurnUsageSide::Client,
        received_bytes: 999,
        sent_bytes: 2_147_483_648,
        collected_at: now,
    };
    store.record_turn_usage(&traffic).await.unwrap();
    assert!(!store.relay_allowed(&team).await.unwrap());
    assert_eq!(
        store.relay_denied_reason(&team).await.unwrap(),
        Some(RelayDeniedReason::TurnQuotaExhausted)
    );
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=NULL WHERE singleton",
        vec![],
    )
    .await;
    store
        .set_enterprise(&operator.id, &team, true)
        .await
        .unwrap();
    assert!(store.relay_allowed(&team).await.unwrap());
    traffic.sent_bytes = 100;
    store.record_turn_usage(&traffic).await.unwrap();
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=$1 WHERE singleton",
        vec![now_ms().into()],
    )
    .await;
    store
        .set_enterprise(&operator.id, &team, false)
        .await
        .unwrap();
    assert!(!store.relay_allowed(&team).await.unwrap());
    assert_eq!(
        store.billing_summary(&team).await.unwrap()["usage"]["relayedBytes"],
        "2147483748"
    );
    let lease = store.claim_billing_operation(&team).await.unwrap().unwrap();
    let upgraded = SubscriptionProjection {
        paid_plan: Some("pro".into()),
        ..projection
    };
    store
        .apply_subscription(&team, &lease, &upgraded, &[])
        .await
        .unwrap();
    store
        .release_billing_operation(&team, &lease)
        .await
        .unwrap();
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=NULL WHERE singleton",
        vec![],
    )
    .await;
    assert_eq!(
        store.relay_denied_reason(&team).await.unwrap(),
        Some(RelayDeniedReason::MeteringUnavailable)
    );
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=$1 WHERE singleton",
        vec![now_ms().into()],
    )
    .await;
    assert!(store.relay_allowed(&team).await.unwrap());
    assert_eq!(
        store.billing_profile(&team).await.unwrap().period_anchor,
        now - 1000
    );
    execute(
        &store,
        "UPDATE cp_billing_profiles SET paid_through=$2 WHERE team_id=$1",
        vec![team.parse::<i64>().unwrap().into(), now_ms().into()],
    )
    .await;
    assert_eq!(
        store.team_entitlements(&team).await.unwrap()["plan"],
        "free"
    );
    assert!(!store.relay_allowed(&team).await.unwrap());
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=NULL WHERE singleton",
        vec![],
    )
    .await;
    assert_eq!(
        store.relay_denied_reason(&team).await.unwrap(),
        Some(RelayDeniedReason::FreePlan)
    );
    assert_eq!(
        store
            .clone()
            .with_hosted_mode(false)
            .team_entitlements(&team)
            .await
            .unwrap()["plan"],
        "selfHosted"
    );
    assert!(
        store
            .clone()
            .with_hosted_mode(false)
            .relay_allowed(&team)
            .await
            .unwrap()
    );
    let rows=store.database().query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,"SELECT id FROM cp_site_audit WHERE action='enterprise.update' AND after_value->>'teamId'=$1",vec![team.into()])).await.unwrap();
    assert_eq!(rows.len(), 2);
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn collector_claims_do_not_refresh_metering_and_heartbeats_require_current_ownership() {
    let _collector_guard = COLLECTOR_TEST_LOCK.lock().await;
    let (store, _, team, _) = fixture().await;
    execute(
        &store,
        "UPDATE cp_turn_collector SET owner=NULL,lease_until=NULL,last_seen_at=NULL,gap_since=NULL WHERE singleton",
        vec![],
    )
    .await;
    let owner = uuid::Uuid::new_v4().to_string();
    for _ in 0..3 {
        assert!(store.claim_turn_collector(&owner).await.unwrap());
        let summary = store.billing_summary(&team).await.unwrap();
        assert_eq!(summary["metering"]["fresh"], false);
        assert!(summary["metering"]["lastSeenAt"].is_null());
        store.turn_collector_gap(&owner).await.unwrap();
    }
    let stale = now_ms() - 60_000;
    execute(
        &store,
        "UPDATE cp_turn_collector SET last_seen_at=$1 WHERE singleton",
        vec![stale.into()],
    )
    .await;
    for _ in 0..3 {
        assert!(store.claim_turn_collector(&owner).await.unwrap());
        let summary = store.billing_summary(&team).await.unwrap();
        assert_eq!(summary["metering"]["fresh"], false);
        assert_eq!(summary["metering"]["lastSeenAt"], timestamp(stale));
    }
    assert!(store.heartbeat_turn_collector(&owner).await.unwrap());
    assert_eq!(
        store.billing_summary(&team).await.unwrap()["metering"]["fresh"],
        true
    );
    let other = uuid::Uuid::new_v4().to_string();
    assert!(!store.heartbeat_turn_collector(&other).await.unwrap());
    execute(
        &store,
        "UPDATE cp_turn_collector SET lease_until=$1 WHERE singleton",
        vec![(now_ms() - 1).into()],
    )
    .await;
    assert!(!store.heartbeat_turn_collector(&owner).await.unwrap());
    assert!(store.claim_turn_collector(&other).await.unwrap());
    assert!(!store.heartbeat_turn_collector(&owner).await.unwrap());
    assert!(store.heartbeat_turn_collector(&other).await.unwrap());
    store.turn_collector_gap(&other).await.unwrap();
    assert!(!store.heartbeat_turn_collector(&other).await.unwrap());
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn payment_inbox_and_profile_leases_fence_stale_workers() {
    let (store, _, team, _) = fixture().await;
    let id = format!("evt_{}", uuid::Uuid::new_v4());
    store
        .receive_payment_event(&id, "invoice.paid", "in_test", None, None)
        .await
        .unwrap();
    store
        .receive_payment_event(&id, "invoice.paid", "in_test", None, None)
        .await
        .unwrap();
    let event = store.claim_payment_event().await.unwrap().unwrap();
    assert_eq!(event.id, id);
    assert!(store.claim_payment_event().await.unwrap().is_none());
    store.finish_payment_event(&event, false).await.unwrap();
    assert!(store.claim_payment_event().await.unwrap().is_none());
    execute(
        &store,
        "UPDATE cp_payment_events SET available_at=0 WHERE id=$1",
        vec![id.into()],
    )
    .await;
    let retry = store.claim_payment_event().await.unwrap().unwrap();
    assert_ne!(retry.claim_token, event.claim_token);
    store.finish_payment_event(&event, true).await.unwrap();
    store.finish_payment_event(&retry, true).await.unwrap();
    assert!(store.claim_payment_event().await.unwrap().is_none());
    let first = store.claim_billing_operation(&team).await.unwrap().unwrap();
    execute(
        &store,
        "UPDATE cp_billing_profiles SET lease_until=0 WHERE team_id=$1",
        vec![team.parse::<i64>().unwrap().into()],
    )
    .await;
    let second = store.claim_billing_operation(&team).await.unwrap().unwrap();
    assert_ne!(first, second);
    assert!(
        store
            .billing_customer(&team, &first, "cus_old")
            .await
            .is_err()
    );
    store
        .release_billing_operation(&team, &first)
        .await
        .unwrap();
    assert!(
        store
            .claim_billing_operation(&team)
            .await
            .unwrap()
            .is_none()
    );
    store
        .billing_customer(&team, &second, &format!("cus_{}", uuid::Uuid::new_v4()))
        .await
        .unwrap();
    store
        .release_billing_operation(&team, &second)
        .await
        .unwrap();
}
