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
        json!({"id":format!("price_{plan}"),"active":true,"type":"recurring","recurring":{"interval":"month","interval_count":1},"unit_amount":if plan=="go"{500}else{1500},"currency":"usd","product":format!("prod_{plan}")})
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
        portal_configuration_id: Some("bpc_fixture".into()),
    };
    let mut service = BillingService::new(config, "https://web.example.test".into()).unwrap();
    service.api_base = format!("http://{address}/v1");
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let url = service
        .checkout(&store, &team.id, "go", &first)
        .await
        .unwrap();
    assert_eq!(
        service
            .checkout(&store, &team.id, "go", &first)
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
        .checkout(&store, &team.id, "go", &second)
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
            json!({"id":sub,"customer":customer,"metadata":{"deskfleet_team_id":team.id,"deskfleet_request_id":second},"items":{"data":[{"price":{"id":"price_go"},"quantity":1}]},"status":"active","current_period_end":now+86_400,"billing_cycle_anchor":now-10,"cancel_at_period_end":false,"latest_invoice":{"id":"in_fixture","subscription":sub,"customer":customer,"status":"open","paid":false,"currency":"usd","lines":{"data":[{"price":{"id":"price_go"},"period":{"end":now+86_400},"amount":500}]}}}),
        );
    }
    assert!(
        service
            .checkout(&store, &team.id, "go", &uuid::Uuid::new_v4().to_string())
            .await
            .is_err(),
        "completed-but-unsynchronized payment cannot create a second subscription"
    );
    service.reconcile_team(&store, &team.id).await.unwrap();
    assert_eq!(
        store.team_entitlements(&team.id).await.unwrap()["plan"],
        "free"
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
        "go"
    );
    let anchor = store.billing_profile(&team.id).await.unwrap().period_anchor;
    {
        let mut state = provider_state.lock().unwrap();
        let subscription = state.subscription.as_mut().unwrap();
        subscription["items"]["data"][0]["price"]["id"] = json!("price_pro");
        subscription["latest_invoice"]["lines"]["data"][0]["price"]["id"] = json!("price_pro");
        subscription["latest_invoice"]["paid"] = json!(false);
        subscription["latest_invoice"]["status"] = json!("open");
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
    handle.stop(true).await;
    task.await.unwrap().unwrap();
}
