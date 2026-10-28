use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::json;
use std::{collections::HashMap, net::TcpListener, sync::Mutex};

#[derive(Default)]
struct Provider {
    customer: String,
    team: String,
    sessions: HashMap<String, Value>,
    requests: HashMap<String, (String, String)>,
    subscription: Option<Value>,
    historical_invoices: HashMap<String, Value>,
    price_reads: Vec<String>,
    price_reads_remaining: Option<usize>,
    created: usize,
    expired: usize,
}
async fn provider(
    req: HttpRequest,
    body: web::Bytes,
    state: web::Data<Mutex<Provider>>,
) -> HttpResponse {
    assert_eq!(req.headers().get("Stripe-Version").unwrap(), "2024-06-20");
    let fields: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let path = req.path();
    let mut state = state.lock().unwrap();
    let value = if let Some(plan) = path.strip_prefix("/v1/prices/price_") {
        state.price_reads.push(plan.into());
        if let Some(remaining) = state.price_reads_remaining.as_mut() {
            if *remaining == 0 {
                return HttpResponse::ServiceUnavailable().finish();
            }
            *remaining -= 1;
        }
        let yearly = plan.ends_with("_year");
        let base = plan.trim_end_matches("_year");
        json!({"id":format!("price_{plan}"),"active":true,"type":"recurring","recurring":{"interval":if yearly{"year"}else{"month"},"interval_count":1},"unit_amount":if base=="go"{if yearly{5000}else{500}}else{if yearly{15000}else{1500}},"currency":"usd","product":"prod_deskfleet"})
    } else if path == "/v1/customers" {
        state.team = fields["metadata[deskfleet_team_id]"].clone();
        if state.customer.is_empty() {
            state.customer = format!("cus_{}", uuid::Uuid::new_v4());
        }
        json!({"id":state.customer})
    } else if path == "/v1/checkout/sessions" && req.method() == "POST" {
        assert_eq!(fields["mode"], "subscription");
        assert_eq!(fields["line_items[0][quantity]"], "1");
        assert_eq!(fields["customer"], state.customer);
        assert!(fields["success_url"].starts_with("https://web.example.test/"));
        assert!(fields["success_url"].ends_with("billing_return=checkout_success"));
        assert!(fields["cancel_url"].ends_with("billing_return=checkout_cancel"));
        let key = req
            .headers()
            .get("Idempotency-Key")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let raw = String::from_utf8(body.to_vec()).unwrap();
        if let Some((id, original)) = state.requests.get(&key) {
            assert_eq!(
                original, &raw,
                "provider retries must preserve exact parameters"
            );
            state.sessions[id].clone()
        } else {
            state.created += 1;
            let id = format!("cs_{}_{}", state.team, state.created);
            let value = json!({"id":id,"url":format!("https://checkout.stripe.com/c/pay/{id}"),"status":"open","customer":state.customer,"metadata":{"deskfleet_team_id":state.team,"deskfleet_request_id":fields["metadata[deskfleet_request_id]"]}});
            state.requests.insert(key, (id.clone(), raw));
            state.sessions.insert(id, value.clone());
            value
        }
    } else if let Some(suffix) = path.strip_prefix("/v1/checkout/sessions/") {
        let id = suffix.trim_end_matches("/expire");
        if suffix.ends_with("/expire") {
            state.expired += 1;
            state.sessions.get_mut(id).unwrap()["status"] = json!("expired");
        }
        state.sessions[id].clone()
    } else if path == "/v1/subscriptions" {
        json!({"data":state.subscription.clone().into_iter().collect::<Vec<_>>(),"has_more":false})
    } else if path.starts_with("/v1/subscriptions/") {
        state.subscription.clone().unwrap()
    } else if let Some(id) = path.strip_prefix("/v1/invoices/") {
        state
            .historical_invoices
            .get(id)
            .cloned()
            .unwrap_or_else(|| state.subscription.as_ref().unwrap()["latest_invoice"].clone())
    } else {
        panic!("unexpected provider request {path}")
    };
    HttpResponse::Ok().json(value)
}

#[actix_web::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL; Stripe is replaced by a local HTTP fixture"]
async fn checkout_recovery_and_verified_payment_projection() {
    let store =
        ControlStore::connect(&std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL"))
            .await
            .unwrap()
            .with_hosted_mode(true);
    let user = store
        .verified_user(
            &format!("checkout-{}@example.test", uuid::Uuid::new_v4()),
            "Owner",
        )
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Checkout").await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let provider_state = web::Data::new(Mutex::new(Provider::default()));
    let server_state = provider_state.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_state.clone())
            .default_service(web::route().to(provider))
    })
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    let task = actix_web::rt::spawn(server);
    let config = BillingConfig {
        hosted: true,
        stripe_secret_key: Some("sk_test_fixture".into()),
        stripe_webhook_secret: Some("whsec_fixture".into()),
        go_price_id: Some("price_go".into()),
        pro_price_id: Some("price_pro".into()),
        go_yearly_price_id: Some("price_go_year".into()),
        pro_yearly_price_id: Some("price_pro_year".into()),
        portal_configuration_id: Some("bpc_month".into()),
        yearly_portal_configuration_id: Some("bpc_year".into()),
        enterprise_contact_email: None,
        statsig_server_key: Some("secret-fixture".into()),
        statsig_environment: None,
    };
    let mut service = BillingService::new(config, "https://web.example.test".into()).unwrap();
    service.api_base = format!("http://{address}/v1");
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let url = service
        .checkout(&store, &team.id, &user.id, "go", "month", &first)
        .await
        .unwrap();
    assert_eq!(
        service
            .checkout(&store, &team.id, &user.id, "go", "month", &first)
            .await
            .unwrap(),
        url
    );
    assert_eq!(provider_state.lock().unwrap().created, 1);
    // Model a lost database response after Stripe created the session. Reusing
    // its provider request identity recovers it before a replacement is created.
    store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_checkout_attempts SET session_id=NULL,status='pending' WHERE request_id=$1",
            vec![first.into()],
        ))
        .await
        .unwrap();
    service
        .checkout(&store, &team.id, &user.id, "go", "month", &second)
        .await
        .unwrap();
    assert_eq!(provider_state.lock().unwrap().created, 2);
    assert_eq!(provider_state.lock().unwrap().expired, 1);
    let now = deskfleet_control_store::now_ms() / 1000;
    let sub = format!("sub_{}", uuid::Uuid::new_v4());
    {
        let mut state = provider_state.lock().unwrap();
        let customer = state.customer.clone();
        state
            .sessions
            .get_mut(&format!("cs_{}_2", team.id))
            .unwrap()["status"] = json!("complete");
        state
            .sessions
            .get_mut(&format!("cs_{}_2", team.id))
            .unwrap()["subscription"] = json!(sub);
        state.subscription = Some(
            json!({"id":sub,"customer":customer,"metadata":{"deskfleet_team_id":team.id,"deskfleet_request_id":second},"items":{"data":[{"price":{"id":"price_go"},"quantity":1}]},"status":"active","current_period_end":now+86_400,"billing_cycle_anchor":now-10,"cancel_at_period_end":false,"latest_invoice":{"id":format!("in_{}_initial",team.id),"subscription":sub,"customer":customer,"status":"open","paid":false,"currency":"usd","billing_reason":"subscription_create","amount_due":500,"lines":{"data":[{"price":{"id":"price_go"},"period":{"end":now+86_400},"amount":500}]}}}),
        );
    }
    assert!(
        service
            .checkout(
                &store,
                &team.id,
                &user.id,
                "go",
                "month",
                &uuid::Uuid::new_v4().to_string()
            )
            .await
            .is_err(),
        "completed-but-unsynchronized payment cannot create a second subscription"
    );
    // Model a crash before the atomic session/outbox commit. Reconciliation must
    // recover both completion and its created fact without another client call.
    store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_checkout_attempts SET session_id=NULL,status='pending' WHERE request_id=$1",
            vec![second.clone().into()],
        ))
        .await
        .unwrap();
    store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM cp_billing_analytics WHERE event_id=$1",
            vec![format!("checkout:{second}").into()],
        ))
        .await
        .unwrap();
    provider_state.lock().unwrap().price_reads_remaining = Some(1);
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert_eq!(
        store
            .checkout_attempt(&second)
            .await
            .unwrap()
            .unwrap()
            .status,
        "complete"
    );
    assert_eq!(
        store.team_entitlements(&team.id).await.unwrap()["plan"],
        "free"
    );
    {
        let mut state = provider_state.lock().unwrap();
        let subscription = state.subscription.as_mut().unwrap();
        subscription["latest_invoice"]["paid"] = json!(true);
        subscription["latest_invoice"]["status"] = json!("paid");
        subscription["latest_invoice"]["amount_paid"] = json!(500);
        subscription["latest_invoice"]["status_transitions"]["paid_at"] = json!(now);
    }
    let paid_event = deskfleet_control_store::billing::PaymentEvent {
        id: format!("evt_{}_paid", team.id),
        event_type: "invoice.paid".into(),
        object_id: format!("in_{}_initial", team.id),
        claim_token: "claim".into(),
        occurred_at: Some(now * 1000),
        payment_attempt: Some(1),
    };
    provider_state.lock().unwrap().price_reads_remaining = Some(1);
    assert!(service.process_event(&store, &paid_event).await.is_err());
    assert_eq!(
        store.team_entitlements(&team.id).await.unwrap()["plan"],
        "go"
    );
    // The historical-analytics fetch failed, but entitlement verification used
    // its one successful Price response and already committed paid coverage.
    provider_state.lock().unwrap().price_reads_remaining = None;
    service.process_event(&store, &paid_event).await.unwrap();
    let anchor = store.billing_profile(&team.id).await.unwrap().period_anchor;
    service.reconcile_team(&store, &team.id).await.unwrap();
    // The original failure remains measurable even if success preceded processing
    // its signed webhook. The paid invoice is not emitted again on this repair.
    service
        .process_event(
            &store,
            &deskfleet_control_store::billing::PaymentEvent {
                id: format!("evt_{}_failed", team.id),
                event_type: "invoice.payment_failed".into(),
                object_id: format!("in_{}_initial", team.id),
                claim_token: "claim".into(),
                occurred_at: Some((now - 5) * 1000),
                payment_attempt: Some(1),
            },
        )
        .await
        .unwrap();
    {
        let mut state = provider_state.lock().unwrap();
        let original = state.subscription.as_ref().unwrap()["latest_invoice"].clone();
        state
            .historical_invoices
            .insert(paid_event.object_id.clone(), original);
        let subscription = state.subscription.as_mut().unwrap();
        subscription["items"]["data"][0]["price"]["id"] = json!("price_pro");
        subscription["latest_invoice"]["lines"]["data"][0]["price"]["id"] = json!("price_pro");
        subscription["latest_invoice"]["paid"] = json!(false);
        subscription["latest_invoice"]["status"] = json!("open");
        subscription["latest_invoice"]["id"] = json!(format!("in_{}_upgrade", team.id));
        subscription["latest_invoice"]["billing_reason"] = json!("subscription_update");
    }
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert_eq!(
        store.team_entitlements(&team.id).await.unwrap()["plan"],
        "go"
    );
    {
        let mut state = provider_state.lock().unwrap();
        let subscription = state.subscription.as_mut().unwrap();
        subscription["latest_invoice"]["paid"] = json!(true);
        subscription["latest_invoice"]["status"] = json!("paid");
    }
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert_eq!(
        store.team_entitlements(&team.id).await.unwrap()["plan"],
        "pro"
    );
    assert_eq!(
        store.billing_profile(&team.id).await.unwrap().period_anchor,
        anchor
    );
    provider_state.lock().unwrap().price_reads.clear();
    service.process_event(&store, &paid_event).await.unwrap();
    assert_eq!(provider_state.lock().unwrap().price_reads, ["pro", "go"]);
    // A later Portal actor is attributed only to their own action; renewal keeps
    // the original checkout actor and its independent provider invoice identity.
    let portal_actor = store
        .verified_user(
            &format!("portal-{}@example.test", uuid::Uuid::new_v4()),
            "Administrator",
        )
        .await
        .unwrap();
    service
        .record_portal(
            &store,
            &team.id,
            &portal_actor.id,
            &json!({"id":format!("bps_{}",team.id)}),
        )
        .await
        .unwrap();
    {
        let mut state = provider_state.lock().unwrap();
        let invoice = &mut state.subscription.as_mut().unwrap()["latest_invoice"];
        invoice["id"] = json!(format!("in_{}_renewal", team.id));
        invoice["billing_reason"] = json!("subscription_cycle");
        invoice["amount_paid"] = json!(1500);
        invoice["amount_due"] = json!(1500);
        invoice["lines"]["data"][0]["amount"] = json!(1500);
        invoice["lines"]["data"][0]["period"]["end"] = json!(now + 172_800);
    }
    service.reconcile_team(&store, &team.id).await.unwrap();
    service.reconcile_team(&store, &team.id).await.unwrap();
    provider_state
        .lock()
        .unwrap()
        .subscription
        .as_mut()
        .unwrap()["cancel_at_period_end"] = json!(true);
    service.reconcile_team(&store, &team.id).await.unwrap();
    service.reconcile_team(&store, &team.id).await.unwrap();
    provider_state
        .lock()
        .unwrap()
        .subscription
        .as_mut()
        .unwrap()["cancel_at_period_end"] = json!(false);
    service.reconcile_team(&store, &team.id).await.unwrap();
    provider_state
        .lock()
        .unwrap()
        .subscription
        .as_mut()
        .unwrap()["status"] = json!("canceled");
    service.reconcile_team(&store, &team.id).await.unwrap();
    service.reconcile_team(&store, &team.id).await.unwrap();
    let events: Vec<Value> = store
        .database()
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT event FROM cp_billing_analytics WHERE team_id=$1",
            vec![team.id.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "event").unwrap())
        .collect();
    for (name, count) in [
        ("billing_checkout_created", 2),
        ("billing_portal_opened", 1),
        ("billing_invoice_paid", 3),
        ("billing_invoice_payment_failed", 1),
        ("billing_subscription_cancel_scheduled", 1),
        ("billing_subscription_cancel_reverted", 1),
        ("billing_subscription_ended", 1),
    ] {
        assert_eq!(
            events.iter().filter(|event| event["name"] == name).count(),
            count,
            "{name}"
        );
    }
    assert!(events.iter().all(|event| event["user_id"]
        == if event["name"] == "billing_portal_opened" {
            portal_actor.id.as_str()
        } else {
            user.id.as_str()
        }));
    assert!(
        events
            .iter()
            .filter(|event| event["name"] == "billing_checkout_created")
            .all(|event| event["id"]
                == format!(
                    "checkout:{}",
                    event["metadata"]["request_id"].as_str().unwrap()
                ))
    );
    for reason in [
        "subscription_create",
        "subscription_update",
        "subscription_cycle",
    ] {
        assert_eq!(
            events
                .iter()
                .filter(|event| event["name"] == "billing_invoice_paid"
                    && event["metadata"]["billing_reason"] == reason)
                .count(),
            1
        );
    }
    handle.stop(true).await;
    task.await.unwrap().unwrap();
}
