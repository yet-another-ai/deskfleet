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
    portal_configurations: Vec<String>,
    created: usize,
    expired: usize,
}
async fn provider(
    req: HttpRequest,
    body: web::Bytes,
    state: web::Data<Mutex<Provider>>,
) -> HttpResponse {
    assert_eq!(
        req.headers().get("Stripe-Version").unwrap(),
        "2026-09-30.endive"
    );
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
        json!({"id":format!("price_{plan}"),"active":true,"type":"recurring","recurring":{"interval":if yearly{"year"}else{"month"},"interval_count":1},"unit_amount":if base=="go"{if yearly{5000}else{500}}else{if yearly{15000}else{1500}},"currency":"usd","product":format!("prod_{base}")})
    } else if path == "/v1/billing_portal/configurations/bpc_deskfleet" {
        json!({
            "id":"bpc_deskfleet","active":true,
            "features":{
                "subscription_update":{
                    "enabled":true,"default_allowed_updates":["price"],
                    "proration_behavior":"always_invoice",
                    "schedule_at_period_end":{"conditions":[]},
                    "products":[
                        {"product":"prod_go","prices":["price_go","price_go_year"]},
                        {"product":"prod_pro","prices":["price_pro","price_pro_year"]}
                    ]
                },
                "subscription_cancel":{"enabled":true,"mode":"at_period_end"},
                "invoice_history":{"enabled":true},
                "payment_method_update":{"enabled":true}
            }
        })
    } else if path == "/v1/billing_portal/sessions" && req.method() == "POST" {
        assert_eq!(fields["customer"], state.customer);
        assert!(fields["return_url"].starts_with("https://web.example.test/"));
        assert!(fields["return_url"].ends_with("billing_return=portal"));
        state
            .portal_configurations
            .push(fields["configuration"].clone());
        let id = format!("bps_{}", uuid::Uuid::new_v4());
        json!({"id":id,"url":format!("https://billing.stripe.com/p/session/{id}")})
    } else if path == "/v1/customers" {
        state.team = fields["metadata[deskfleet_team_id]"].clone();
        if state.customer.is_empty() {
            state.customer = format!("cus_{}", uuid::Uuid::new_v4());
        }
        json!({"id":state.customer})
    } else if path == "/v1/checkout/sessions" && req.method() == "POST" {
        assert_eq!(fields["mode"], "subscription");
        assert_eq!(fields["subscription_data[billing_mode][type]"], "flexible");
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

fn fixture_config() -> BillingConfig {
    BillingConfig {
        hosted: true,
        stripe_secret_key: Some("sk_test_fixture".into()),
        stripe_webhook_secret: Some("whsec_fixture".into()),
        go_price_id: Some("price_go".into()),
        pro_price_id: Some("price_pro".into()),
        go_yearly_price_id: Some("price_go_year".into()),
        pro_yearly_price_id: Some("price_pro_year".into()),
        portal_configuration_id: Some("bpc_deskfleet".into()),
        enterprise_contact_email: None,
        statsig_server_key: Some("secret-fixture".into()),
        statsig_environment: None,
    }
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
    let config = fixture_config();
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
        state.subscription = Some(json!({
            "id":sub,"customer":customer,
            "metadata":{"deskfleet_team_id":team.id,"deskfleet_request_id":second},
            "items":{"data":[{"price":{"id":"price_go"},"quantity":1,"current_period_end":now+86_400}]},
            "status":"active","billing_mode":{"type":"flexible"},
            "billing_cycle_anchor":now-10,"cancel_at_period_end":false,"cancel_at":null,
            "latest_invoice":{
                "id":format!("in_{}_initial",team.id),
                "parent":{"type":"subscription_details","subscription_details":{"subscription":sub}},
                "customer":customer,"status":"open","currency":"usd",
                "billing_reason":"subscription_create","amount_due":500,
                "lines":{"data":[{"pricing":{"type":"price_details","price_details":{"price":"price_go"}},"period":{"end":now+86_400},"amount":500}]}
            }
        }));
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
        subscription["latest_invoice"]["lines"]["data"][0]["pricing"]["price_details"]["price"] =
            json!("price_pro");
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
        let subscription = state.subscription.as_mut().unwrap();
        subscription["items"]["data"][0]["current_period_end"] = json!(now + 172_800);
        let invoice = &mut subscription["latest_invoice"];
        invoice["id"] = json!(format!("in_{}_renewal", team.id));
        invoice["billing_reason"] = json!("subscription_cycle");
        invoice["amount_paid"] = json!(1500);
        invoice["amount_due"] = json!(1500);
        invoice["lines"]["data"][0]["amount"] = json!(1500);
        invoice["lines"]["data"][0]["period"]["end"] = json!(now + 172_800);
    }
    service.reconcile_team(&store, &team.id).await.unwrap();
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert_eq!(
        store.billing_profile(&team.id).await.unwrap().paid_through,
        Some((now + 172_800) * 1000)
    );
    {
        let mut state = provider_state.lock().unwrap();
        let subscription = state.subscription.as_mut().unwrap();
        subscription["cancel_at"] = subscription["items"]["data"][0]["current_period_end"].clone();
    }
    service.reconcile_team(&store, &team.id).await.unwrap();
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert!(
        store
            .billing_profile(&team.id)
            .await
            .unwrap()
            .cancel_at_period_end
    );
    provider_state
        .lock()
        .unwrap()
        .subscription
        .as_mut()
        .unwrap()["cancel_at"] = json!(null);
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert!(
        !store
            .billing_profile(&team.id)
            .await
            .unwrap()
            .cancel_at_period_end
    );
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

/// Model Stripe's authoritative subscription and its credit/debit proration lines.
fn subscription_update(
    state: &web::Data<Mutex<Provider>>,
    price: &str,
    end: i64,
    credit: i64,
    debit: i64,
    paid: bool,
) {
    let mut state = state.lock().unwrap();
    let subscription = state.subscription.as_mut().unwrap();
    let previous_price = subscription["items"]["data"][0]["price"]["id"].clone();
    let previous_end = subscription["items"]["data"][0]["current_period_end"].clone();
    subscription["items"]["data"][0]["price"]["id"] = json!(price);
    subscription["items"]["data"][0]["current_period_end"] = json!(end);
    subscription["status"] = json!(if paid { "active" } else { "past_due" });
    subscription["latest_invoice"] = json!({
        "id":format!("in_{}",uuid::Uuid::new_v4()),
        "parent":{"type":"subscription_details","subscription_details":{"subscription":subscription["id"]}},
        "customer":subscription["customer"],
        "status":if paid {"paid"}else{"open"},"currency":"usd",
        "billing_reason":"subscription_update","total":credit+debit,
        "amount_due":(credit+debit).max(0),
        "amount_paid":if paid {(credit+debit).max(0)}else{0},
        "lines":{"has_more":false,"data":[
            {"pricing":{"type":"price_details","price_details":{"price":previous_price}},"period":{"end":previous_end},"amount":credit},
            {"pricing":{"type":"price_details","price_details":{"price":price}},"period":{"end":end},"amount":debit}
        ]}
    });
}

#[actix_web::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL; Stripe is replaced by a local HTTP fixture"]
async fn one_portal_applies_paid_plan_and_interval_changes_without_resetting_usage() {
    let store =
        ControlStore::connect(&std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL"))
            .await
            .unwrap()
            .with_hosted_mode(true);
    let user = store
        .verified_user(
            &format!("portal-changes-{}@example.test", uuid::Uuid::new_v4()),
            "Owner",
        )
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Portal changes").await.unwrap();
    let customer = format!("cus_{}", uuid::Uuid::new_v4());
    let lease = store
        .claim_billing_operation(&team.id)
        .await
        .unwrap()
        .unwrap();
    store
        .billing_customer(&team.id, &lease, &customer)
        .await
        .unwrap();
    store
        .release_billing_operation(&team.id, &lease)
        .await
        .unwrap();
    let now = deskfleet_control_store::now_ms() / 1000;
    let anchor = now - 86_400;
    let month_end = now + 29 * 86_400;
    let year_end = now + 365 * 86_400;
    let subscription = format!("sub_{}", uuid::Uuid::new_v4());
    let provider_state = web::Data::new(Mutex::new(Provider {
        customer: customer.clone(),
        team: team.id.clone(),
        subscription: Some(json!({
            "id":subscription,"customer":customer,"metadata":{"deskfleet_team_id":team.id},
            "items":{"data":[{"quantity":1,"price":{"id":"price_go"},"current_period_end":month_end}]},
            "status":"active","billing_mode":{"type":"flexible"},"billing_cycle_anchor":anchor,
            "cancel_at_period_end":false,"cancel_at":null,
            "latest_invoice":{
                "id":format!("in_{}",uuid::Uuid::new_v4()),
                "parent":{"type":"subscription_details","subscription_details":{"subscription":subscription}},
                "customer":customer,"status":"paid","currency":"usd",
                "amount_paid":500,"total":500,
                "lines":{"data":[{"pricing":{"type":"price_details","price_details":{"price":"price_go"}},"period":{"end":month_end},"amount":500}]}
            }
        })),
        ..Provider::default()
    }));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
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
    let mut config = fixture_config();
    config.statsig_server_key = None;
    let mut service = BillingService::new(config, "https://web.example.test".into()).unwrap();
    service.api_base = format!("http://{address}/v1");
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert_eq!(
        store.team_entitlements(&team.id).await.unwrap()["plan"],
        "go"
    );

    // Seed already collected usage in a complete minute before any interval switch.
    // Switching billing intervals must not make this paid-period usage disappear.
    store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO cp_turn_usage_minutes(team_id,minute_at,sent_bytes) VALUES($1,$2,1234)",
            vec![
                team.id.parse::<i64>().unwrap().into(),
                ((now - 300) / 60 * 60_000).into(),
            ],
        ))
        .await
        .unwrap();
    let summary = store.billing_summary(&team.id).await.unwrap();
    assert_eq!(summary["usage"]["relayedBytes"], "1234");
    assert!(
        service
            .portal(&store, &team.id, &user.id)
            .await
            .unwrap()
            .starts_with("https://billing.stripe.com/")
    );

    // Even if Stripe's subscription item has already changed, an unpaid upgrade
    // must retain the last paid plan and deadline.
    subscription_update(&provider_state, "price_pro", month_end, -250, 750, false);
    service.reconcile_team(&store, &team.id).await.unwrap();
    let unpaid = store.billing_profile(&team.id).await.unwrap();
    assert_eq!(unpaid.plan.as_deref(), Some("go"));
    assert_eq!(unpaid.paid_through, Some(month_end * 1000));
    {
        let mut state = provider_state.lock().unwrap();
        let subscription = state.subscription.as_mut().unwrap();
        subscription["status"] = json!("active");
        subscription["latest_invoice"]["status"] = json!("paid");
        subscription["latest_invoice"]["amount_paid"] = json!(500);
    }
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert_eq!(
        store.team_entitlements(&team.id).await.unwrap()["plan"],
        "pro"
    );

    for (price, plan, end, credit, debit) in [
        ("price_go", "go", month_end, -750, 250),
        ("price_go_year", "go", year_end, -250, 5000),
        ("price_pro_year", "pro", year_end, -2500, 7500),
        ("price_pro", "pro", month_end + 86_400, -7500, 1500),
        ("price_go", "go", month_end + 86_400, -750, 250),
        ("price_pro_year", "pro", year_end + 20, -250, 15000),
        ("price_go", "go", month_end + 30, -15000, 500),
    ] {
        let initially_paid = price != "price_go_year";
        subscription_update(&provider_state, price, end, credit, debit, initially_paid);
        if !initially_paid {
            let before = store.billing_profile(&team.id).await.unwrap();
            service.reconcile_team(&store, &team.id).await.unwrap();
            let unpaid = store.billing_profile(&team.id).await.unwrap();
            assert_eq!(unpaid.plan, before.plan);
            assert_eq!(unpaid.paid_through, before.paid_through);
            assert_eq!(unpaid.period_anchor, before.period_anchor);
            let mut state = provider_state.lock().unwrap();
            let subscription = state.subscription.as_mut().unwrap();
            subscription["status"] = json!("active");
            subscription["latest_invoice"]["status"] = json!("paid");
            subscription["latest_invoice"]["amount_paid"] = json!((credit + debit).max(0));
        }
        service.reconcile_team(&store, &team.id).await.unwrap();
        let profile = store.billing_profile(&team.id).await.unwrap();
        assert_eq!(profile.plan.as_deref(), Some(plan), "{price}");
        assert_eq!(profile.paid_through, Some(end * 1000), "{price}");
        assert_eq!(profile.period_anchor, anchor * 1000, "{price}");
        let updated = store.billing_summary(&team.id).await.unwrap();
        assert_eq!(updated["plan"], plan, "{price}");
        assert_eq!(updated["usage"]["relayedBytes"], "1234", "{price}");
        assert_eq!(updated["period"], summary["period"], "{price}");
        if price == "price_go_year" {
            service.portal(&store, &team.id, &user.id).await.unwrap();
        }
    }
    assert_eq!(
        provider_state.lock().unwrap().portal_configurations,
        ["bpc_deskfleet", "bpc_deskfleet"]
    );
    handle.stop(true).await;
    task.await.unwrap().unwrap();
}
