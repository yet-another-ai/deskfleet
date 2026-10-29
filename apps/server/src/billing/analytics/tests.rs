use super::*;
use crate::billing::BillingConfig;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use std::{net::TcpListener, sync::Mutex};

fn invoice() -> Value {
    json!({
        "status":"paid", "paid":true, "amount_paid":4500, "amount_due":4500,
        "currency":"usd", "billing_reason":"subscription_create",
        "status_transitions":{"paid_at":1700000000},
        "customer_email":"private@example.test", "description":"private billing details"
    })
}

#[test]
fn paid_fact_requires_payment_evidence_and_preserves_money_timestamp_identity() {
    let mut value = invoice();
    let fact = invoice_fact(
        &value,
        "in_123",
        Some("account-uuid".into()),
        "go",
        "year",
        None,
    )
    .unwrap();
    assert_eq!(fact.name, "billing_invoice_paid");
    assert_eq!(fact.id, "invoice:in_123:paid");
    assert_eq!(fact.time, 1_700_000_000_000);
    assert_eq!(fact.value, Some(4500));
    assert_eq!(fact.metadata["interval"], "year");
    assert_eq!(fact.metadata["billing_reason"], "subscription_create");
    value["paid"] = json!(false);
    assert!(invoice_fact(&value, "in_123", None, "go", "year", None).is_none());
    value["paid"] = json!(true);
    value["status"] = json!("open");
    assert!(invoice_fact(&value, "in_123", None, "go", "year", None).is_none());
}

#[test]
fn failed_attempt_survives_later_payment_and_replays_have_the_same_identity() {
    let webhook = PaymentEvent {
        id: "evt_failure".into(),
        event_type: "invoice.payment_failed".into(),
        object_id: "in_123".into(),
        claim_token: "lease".into(),
        occurred_at: Some(1_699_999_000_000),
        payment_attempt: Some(2),
    };
    let fact = invoice_fact(
        &invoice(),
        "in_123",
        Some("account-uuid".into()),
        "pro",
        "month",
        Some(&webhook),
    )
    .unwrap();
    assert_eq!(fact.name, "billing_invoice_payment_failed");
    assert_eq!(fact.id, "invoice:in_123:failed:2");
    assert_eq!(fact.time, 1_699_999_000_000);
    assert_eq!(fact.value, Some(4500));
    let paid = invoice_fact(
        &invoice(),
        "in_123",
        Some("account-uuid".into()),
        "pro",
        "month",
        None,
    )
    .unwrap();
    assert_ne!(fact.id, paid.id);
}

#[test]
fn delivery_joins_exact_account_and_team_and_only_serializes_selected_fields() {
    let delivery = BillingAnalyticsDelivery {
        event: invoice_fact(
            &invoice(),
            "in_123",
            Some("account-uuid".into()),
            "go",
            "year",
            None,
        )
        .unwrap(),
        team_id: "7".into(),
        claim_token: "private-lease".into(),
    };
    let body = request_body(&delivery, "staging");
    let event = &body["events"][0];
    assert_eq!(event["user"]["userID"], "account-uuid");
    assert_eq!(event["user"]["customIDs"]["teamID"], "7");
    assert_eq!(event["user"]["statsigEnvironment"]["tier"], "staging");
    assert_eq!(event["metadata"]["event_id"], "invoice:in_123:paid");
    assert_eq!(event["value"], 4500);
    let encoded = body.to_string();
    assert!(!encoded.contains("private"));
    assert!(!encoded.contains("customer_email"));
    assert!(!encoded.contains("description"));
}

#[derive(Default)]
struct Receiver {
    requests: Mutex<Vec<Value>>,
}

async fn receive(
    req: HttpRequest,
    body: web::Json<Value>,
    receiver: web::Data<Receiver>,
) -> HttpResponse {
    assert_eq!(
        req.headers().get("statsig-api-key").unwrap(),
        "secret-fixture"
    );
    let mut requests = receiver.requests.lock().unwrap();
    requests.push(body.into_inner());
    if requests.len() == 1 {
        HttpResponse::ServiceUnavailable().json(json!({"success":false}))
    } else {
        HttpResponse::Accepted().json(json!({"success":true}))
    }
}

#[actix_web::test]
async fn failed_http_delivery_retries_identical_event_payload_without_exposing_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let receiver = web::Data::new(Receiver::default());
    let server_state = receiver.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_state.clone())
            .default_service(web::post().to(receive))
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    let task = actix_web::rt::spawn(server);
    let service = BillingService::new(
        BillingConfig {
            statsig_server_key: Some("secret-fixture".into()),
            statsig_environment: Some("staging".into()),
            ..Default::default()
        },
        "https://web.example.test".into(),
    )
    .unwrap();
    let delivery = BillingAnalyticsDelivery {
        event: invoice_fact(
            &invoice(),
            "in_123",
            Some("account-uuid".into()),
            "go",
            "year",
            None,
        )
        .unwrap(),
        team_id: "7".into(),
        claim_token: "claim".into(),
    };
    let endpoint = format!("http://{address}/v1/log_event");
    assert!(!service.deliver_analytics(&delivery, &endpoint).await);
    assert!(service.deliver_analytics(&delivery, &endpoint).await);
    {
        let requests = receiver.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
    }
    handle.stop(true).await;
    task.await.unwrap().unwrap();
}
