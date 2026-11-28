use super::*;
use deskfleet_control_store::ControlStore;
use std::sync::Mutex;

struct EveFixture {
    store: ControlStore,
    team: String,
    admin: String,
    prewarms: Mutex<Vec<String>>,
    deliveries: Mutex<Vec<(Value, Value)>>,
}

const SESSION: &str = "wrun_rich";

async fn prewarm(
    req: HttpRequest,
    body: web::Json<Value>,
    eve: web::Data<EveFixture>,
) -> HttpResponse {
    check_secret(&req);
    assert!(body.get("message").is_none());
    assert!(!req.headers().contains_key(SENDER_HEADER));
    {
        let mut attempts = eve.prewarms.lock().unwrap();
        attempts.push(body["operationId"].as_str().unwrap().to_owned());
        if attempts.len() == 1 {
            return HttpResponse::ServiceUnavailable().finish();
        }
    }
    // The operation was admitted, but capacity changes before binding and delivery.
    let mut limits = eve.store.plan_limits(Plan::Free).await.unwrap();
    limits.super_agent_tokens = Some(0);
    eve.store
        .update_plan_limits(&eve.admin, Plan::Free, limits)
        .await
        .unwrap();
    HttpResponse::Accepted().json(json!({"sessionId": SESSION}))
}

async fn deliver(
    req: HttpRequest,
    body: web::Json<Value>,
    eve: web::Data<EveFixture>,
) -> HttpResponse {
    check_secret(&req);
    // A paid first turn must already belong to the requesting Team.
    assert!(
        eve.store
            .owns_cloud_session(&eve.team, SESSION)
            .await
            .unwrap()
    );
    let key = body["idempotencyKey"].as_str().unwrap().to_owned();
    let sender: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(req.headers().get(SENDER_HEADER).unwrap().as_bytes())
            .unwrap(),
    )
    .unwrap();
    let mut deliveries = eve.deliveries.lock().unwrap();
    deliveries.push((body.into_inner(), sender));
    if deliveries.len() == 1 {
        // Eve received the message, but DeskFleet did not receive the delivery receipt.
        return HttpResponse::ServiceUnavailable().finish();
    }
    HttpResponse::Accepted().json(json!({"deliveryId": format!("delivery_{key}")}))
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn rich_first_delivery_survives_lost_ack_and_exhaustion_and_followups_keep_their_parts() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let (database, state, sdk) = fixture_state(listener.local_addr().unwrap()).await;
    let store = state.store.clone();
    let user = store
        .verified_user("rich@fixture.test", "Rich message test")
        .await
        .unwrap();
    store.grant_site_admin(&user.id).await.unwrap();
    let mut free = store.plan_limits(Plan::Free).await.unwrap();
    free.super_agent_tokens = Some(8);
    store
        .update_plan_limits(&user.id, Plan::Free, free)
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Design").await.unwrap();
    let other = store.create_team(&user.id, "Separate Team").await.unwrap();
    let teammate = store
        .verified_user("reviewer@fixture.test", "林美玲")
        .await
        .unwrap();
    let invite = store
        .invite(&user.id, &team.id, "reviewer@fixture.test", "member")
        .await
        .unwrap();
    store
        .accept_invite(&teammate.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    sdk.override_gate(rollout::GATE, true, Some(&team.id));
    sdk.override_gate(rollout::GATE, true, Some(&other.id));
    let login = store.new_session(&user.id).await.unwrap();
    let token = format!("Bearer {}", login["token"].as_str().unwrap());
    let teammate_login = store.new_session(&teammate.id).await.unwrap();
    let teammate_token = format!("Bearer {}", teammate_login["token"].as_str().unwrap());
    let post_as = |path: &str, body: &Value, authorization: &str| {
        test::TestRequest::post()
            .uri(path)
            .insert_header(("Authorization", authorization))
            .insert_header((
                SENDER_HEADER,
                URL_SAFE_NO_PAD.encode(r#"{"id":"forged","name":"Forged"}"#),
            ))
            .set_json(body)
            .to_request()
    };
    let post = |path: &str, body: &Value| post_as(path, body, &token);
    let eve = web::Data::new(EveFixture {
        store: store.clone(),
        team: team.id.clone(),
        admin: user.id.clone(),
        prewarms: Mutex::default(),
        deliveries: Mutex::default(),
    });
    let fixture = eve.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(fixture.clone())
            .route("/eve/v1/session", web::post().to(prewarm))
            .route(
                &format!("/eve/v1/session/{SESSION}"),
                web::post().to(deliver),
            )
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(state))
            .configure(crate::configure),
    )
    .await;
    let path = format!("/api/teams/{}/super-agent/sessions", team.id);
    let sends = format!("{path}/{SESSION}/messages");
    let other_sends = format!(
        "/api/teams/{}/super-agent/sessions/{SESSION}/messages",
        other.id
    );

    let parts = json!([
        {"type":"text", "text":"Check the design"},
        {"type":"file", "filename":"design.png", "mediaType":"image/png", "data":"https://assets.example.test/design.png"},
        {"type":"text", "text":"Focus on the contrast."}
    ]);
    let create = json!({"operationId":uuid::Uuid::new_v4(), "message":parts});
    for invalid in [
        Value::Null,
        json!([]),
        json!([{"type":"other"}]),
        json!([{"type":"text", "text":"  "}]),
        json!([{"type":"file","mediaType":"image/png","data":" Eve-Sandbox:private"}]),
        Value::Array(vec![json!({"type":"text","text":"x"}); 65]),
    ] {
        let mut body = create.clone();
        body["message"] = invalid;
        assert_eq!(
            test::call_service(&app, post(&path, &body)).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    let oversized = test::TestRequest::post()
        .uri(&path)
        .insert_header(("Authorization", token.as_str()))
        .set_json(&create)
        .insert_header(("Content-Length", (MAX_MESSAGE_BODY + 1).to_string()))
        .to_request();
    assert_eq!(
        test::call_service(&app, oversized).await.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(eve.prewarms.lock().unwrap().is_empty());
    assert_eq!(
        test::call_service(&app, post(&path, &create))
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(eve.deliveries.lock().unwrap().is_empty());
    // Retry the failed prewarm immediately. The first delivery then loses its acknowledgement.
    assert_eq!(
        test::call_service(&app, post(&path, &create))
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );

    // An admitted initial delivery can recover its acknowledgement after the Team runs out of tokens.
    let create_again: Value = test::call_and_read_body_json(&app, post(&path, &create)).await;
    {
        let first_calls = eve.deliveries.lock().unwrap();
        assert_eq!(first_calls.len(), 2);
        assert_eq!(first_calls[0], first_calls[1]);
        assert_eq!(first_calls[0].0["message"], parts);
        assert_eq!(first_calls[0].1, json!({"id": user.id, "name": user.name}));
        assert_eq!(
            create_again,
            json!({"sessionId": SESSION, "deliveryId": format!("delivery_{}", first_calls[0].0["idempotencyKey"].as_str().unwrap())})
        );
    }
    let replay: Value = test::call_and_read_body_json(&app, post(&path, &create)).await;
    assert_eq!(replay, create_again);
    let mut changed = create.clone();
    changed["message"][1]["data"] = json!("https://assets.example.test/another.png");
    assert_eq!(
        test::call_service(&app, post(&path, &changed))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let mut fresh = create.clone();
    fresh["operationId"] = json!(uuid::Uuid::new_v4());
    assert_eq!(
        test::call_service(&app, post(&path, &fresh)).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );

    // This valid base64 text file exceeds the old 256 KiB JSON request budget.
    let file = json!([{"type":"file", "mediaType":"text/plain", "filename":"brief.txt", "data":"QUJD".repeat(70 * 1024)}]);
    let followup = json!({"operationId":uuid::Uuid::new_v4(), "message":file});
    assert_eq!(
        test::call_service(&app, post(&other_sends, &followup))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    store
        .update_plan_limits(&user.id, Plan::Free, free)
        .await
        .unwrap();
    let teammate_post = |body: &Value| post_as(&sends, body, &teammate_token);
    let delivery: Value = test::call_and_read_body_json(&app, teammate_post(&followup)).await;
    assert_eq!(delivery["sessionId"], SESSION);
    assert_ne!(delivery["deliveryId"], create_again["deliveryId"]);
    // A Team member archives the Session after both operations were accepted.
    // Replays must read their original receipts without contacting Eve again.
    store
        .lock_cloud_session(&team.id, SESSION)
        .await
        .unwrap()
        .set_archived(true)
        .await
        .unwrap();
    let archived_create: Value = test::call_and_read_body_json(&app, post(&path, &create)).await;
    assert_eq!(archived_create, create_again);
    let repeated: Value = test::call_and_read_body_json(&app, teammate_post(&followup)).await;
    assert_eq!(repeated, delivery);
    let mut changed_followup = followup.clone();
    changed_followup["message"][0]["filename"] = json!("changed.txt");
    assert_eq!(
        test::call_service(&app, teammate_post(&changed_followup))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let next_operation = uuid::Uuid::new_v4();
    let next = json!({"operationId":next_operation, "message":"A new task"});
    assert_eq!(
        test::call_service(&app, teammate_post(&next))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    {
        let attempts = eve.prewarms.lock().unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0], attempts[1]);
    }
    {
        let calls = eve.deliveries.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[2].0["message"], file);
        assert_eq!(
            calls[2].1,
            json!({"id": teammate.id, "name": teammate.name})
        );
    }
    let listed = store.cloud_sessions(&team.id).await.unwrap();
    assert_eq!(listed[0].title.as_deref(), Some("Check the design"));

    // The rejected request did not reserve an operation ID while archived.
    store
        .lock_cloud_session(&team.id, SESSION)
        .await
        .unwrap()
        .set_archived(false)
        .await
        .unwrap();
    let revised = json!({"operationId":next_operation, "message":"A revised task"});
    assert_eq!(
        test::call_service(&app, teammate_post(&revised))
            .await
            .status(),
        StatusCode::ACCEPTED
    );

    drop(app);
    handle.stop(true).await;
    drop(eve);
    store.close().await.unwrap();
    database.close().await;
}
