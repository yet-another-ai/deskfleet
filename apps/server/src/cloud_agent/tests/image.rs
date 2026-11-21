use super::*;
use deskfleet_protocol::control::ControlMessage;

mod model;

#[actix_web::test]
#[ignore = "run scripts/smoke-super-agent-image.ts with a built image"]
async fn dispatch_session() {
    let address = std::env::var("DESKFLEET_TEST_EVE_ADDRESS")
        .expect("set DESKFLEET_TEST_EVE_ADDRESS to the running Eve container")
        .parse()
        .unwrap();
    let (database, state, sdk) = fixture_state(address).await;
    let user = state
        .store
        .verified_user("image@fixture.test", "Image smoke")
        .await
        .unwrap();
    let team = state
        .store
        .create_team(&user.id, "Image smoke")
        .await
        .unwrap();
    sdk.override_gate(rollout::GATE, true, Some(&team.id));
    state.store.grant_site_admin(&user.id).await.unwrap();
    let mut limits = state.store.plan_limits(Plan::Free).await.unwrap();
    limits.super_agent_tokens = Some(1);
    state
        .store
        .update_plan_limits(&user.id, Plan::Free, limits)
        .await
        .unwrap();
    let login = state.store.new_session(&user.id).await.unwrap();
    let auth = format!("Bearer {}", login["token"].as_str().unwrap());
    let (machine, _) = state
        .store
        .enroll(
            &user.id,
            &team.id,
            "image-smoke-worker",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
            &deskfleet_control_store::secret(),
        )
        .await
        .unwrap();
    let (send, mut inbox) = crate::hub::outbox::testing::channel(8);
    let (shutdown, _shutdown_rx) = tokio::sync::watch::channel(None);
    state
        .hub
        .add_daemon(
            &machine.id,
            &team.id,
            &machine.machine_id,
            "fixture",
            send,
            shutdown,
        )
        .await
        .unwrap();
    let address = std::env::var("DESKFLEET_TEST_API_ADDRESS").unwrap();
    let machine_id = web::Data::new(machine.machine_id);
    let state = web::Data::new(state);
    let server_state = state.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_state.clone())
            .app_data(machine_id.clone())
            .route("/v1/chat/completions", web::post().to(model::chat))
            .configure(crate::configure)
    })
    .workers(1)
    .bind(&address)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let client = reqwest::Client::new();
    let sessions = format!(
        "http://{address}/api/teams/{}/super-agent/sessions",
        team.id
    );
    let response = client.post(&sessions).header("Authorization", &auth)
        .json(&json!({"operationId": uuid::Uuid::new_v4(), "message": "Find the worker and dispatch the fixture task"}))
        .send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let created: Value = response.json().await.unwrap();
    let id = created["sessionId"].as_str().unwrap();
    for expected in ["remoteMcpDiscover", "remoteMcp"] {
        let Some(ControlMessage::Request {
            id: request_id,
            method,
            params,
            actor,
        }) = tokio::time::timeout(Duration::from_secs(60), inbox.recv())
            .await
            .expect("Eve must reach the registered machine")
        else {
            panic!("expected a control request")
        };
        assert_eq!(method, expected);
        let actor = actor.unwrap();
        assert_eq!(actor.user_id, user.id);
        let result = if method == "remoteMcpDiscover" {
            json!({"allowSessions": true})
        } else {
            assert_eq!(params["source"]["sessionId"], id);
            assert_eq!(params["operation"], "sessionCreate");
            assert_eq!(params["arguments"]["provider"], "codex");
            assert_eq!(params["arguments"]["prompt"], "Run the fixture task");
            json!({"sessionId": "accepted-fixture-session"})
        };
        state
            .hub
            .response(&machine.id, "fixture", &request_id, Ok(result))
            .await;
    }
    let stream_url = format!("{sessions}/{id}/stream");
    let first_stream = wait_for_reply(&client, &stream_url, &auth, model::COMPLETED).await;
    assert_sender(&first_stream, &created["deliveryId"], &user.id);

    // Another member continues the shared conversation. The live connection
    // must carry this delivery's login through to the originating Agent input.
    let member = state
        .store
        .verified_user("member@fixture.test", "Member")
        .await
        .unwrap();
    let invitation = state
        .store
        .invite(
            &user.id,
            &team.id,
            member.email.as_deref().unwrap(),
            "member",
        )
        .await
        .unwrap();
    state
        .store
        .accept_invite(&member.id, invitation["token"].as_str().unwrap())
        .await
        .unwrap();
    let member_login = state.store.new_session(&member.id).await.unwrap();
    let member_auth = format!("Bearer {}", member_login["token"].as_str().unwrap());
    let follow_up = client
        .post(format!("{sessions}/{id}/messages"))
        .header("Authorization", &member_auth)
        .json(&json!({"operationId": uuid::Uuid::new_v4(), "message": model::FOLLOW_UP}))
        .send()
        .await
        .unwrap();
    assert_eq!(follow_up.status(), reqwest::StatusCode::ACCEPTED);
    let follow_up: Value = follow_up.json().await.unwrap();
    let Some(ControlMessage::Request {
        id: request_id,
        method,
        params,
        actor,
    }) = tokio::time::timeout(Duration::from_secs(60), inbox.recv())
        .await
        .expect("second member's tool call must reach the machine")
    else {
        panic!("expected a control request")
    };
    assert_eq!(method, "remoteMcp");
    assert_eq!(actor.unwrap().user_id, member.id);
    assert_eq!(params["source"]["sessionId"], id);
    assert_eq!(params["operation"], "sessionSend");
    assert_eq!(params["arguments"]["sessionId"], "accepted-fixture-session");
    assert_eq!(params["arguments"]["prompt"], "Continue the fixture task");
    state
        .hub
        .response(
            &machine.id,
            "fixture",
            &request_id,
            Ok(json!({"inputId":"continued-fixture-session"})),
        )
        .await;
    let stream = wait_for_reply(&client, &stream_url, &member_auth, model::CONTINUED).await;
    assert_sender(&stream, &follow_up["deliveryId"], &member.id);
    handle.stop(false).await;
    drop(state);
    database.close().await;
}

async fn wait_for_reply(
    client: &reqwest::Client,
    stream_url: &str,
    auth: &str,
    message: &str,
) -> String {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let stream = client
                .get(stream_url)
                .header("Authorization", auth)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            assert!(stream.headers().contains_key("x-eve-stream-version"));
            let stream = stream.text().await.unwrap();
            if stream.contains(message) {
                break stream;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .expect("the machine receipt must return to the model")
}

fn assert_sender(stream: &str, delivery_id: &Value, user_id: &str) {
    assert!(delivery_id.is_string());
    let principal = stream
        .lines()
        .find_map(|line| {
            let entry: Value = serde_json::from_str(line).unwrap();
            entry["facts"]
                .as_array()?
                .iter()
                .find(|fact| {
                    fact["type"] == "delivery.admitted"
                        && &fact["data"]["deliveryId"] == delivery_id
                })
                .map(|fact| fact["data"]["principal"].clone())
        })
        .expect("the stream must attribute the admitted delivery to a Team member");
    assert_eq!(principal["type"], "user");
    assert_eq!(principal["id"], user_id);
}
