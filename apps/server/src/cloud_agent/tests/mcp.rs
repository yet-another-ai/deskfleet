use super::*;

fn principal(user: &str, login: &str, team: &str, session: &str) -> Value {
    json!({
        "authenticator": "deskfleet", "principalType": "user", "principalId": user,
        "attributes": {"loginId": login, "teamId": team, "sessionId": session}
    })
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn tool_calls_require_the_current_senders_active_login_and_bound_team() {
    let (database, state, sdk) = fixture_state("127.0.0.1:3100".parse().unwrap()).await;
    let store = state.store.clone();
    let owner = store
        .verified_user("owner@fixture.test", "Owner")
        .await
        .unwrap();
    let outsider = store
        .verified_user("outsider@fixture.test", "Outsider")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "One").await.unwrap();
    let other = store.create_team(&owner.id, "Two").await.unwrap();
    let login = store.new_session(&owner.id).await.unwrap();
    let outside_login = store.new_session(&outsider.id).await.unwrap();
    let login_id = login["sessionId"].as_str().unwrap();
    let session = "wrun_hosted";
    store.bind_cloud_session(&team.id, session).await.unwrap();
    sdk.override_gate(rollout::GATE, true, Some(&team.id));
    sdk.override_gate(rollout::GATE, true, Some(&other.id));

    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(state))
            .configure(crate::configure),
    )
    .await;
    let owner_principal = principal(&owner.id, login_id, &team.id, session);
    let call = |token: &str, current: &Value| {
        let forwarded = json!({"initiator": owner_principal, "current": current});
        test::TestRequest::post()
            .uri("/api/super-agent/mcp")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .insert_header((
                "eve-forwarded-principal",
                URL_SAFE_NO_PAD.encode(forwarded.to_string()),
            ))
            .set_json(json!({"jsonrpc":"2.0", "id":1, "method":"tools/call",
                "params":{"name":"deskfleet_remote_machines","arguments":{}}}))
            .to_request()
    };

    let reply: Value =
        test::call_and_read_body_json(&app, call("fixture-secret", &owner_principal)).await;
    let discovery: Value =
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(discovery, json!({"machines":[], "teamId":team.id}));
    let outside = principal(
        &outsider.id,
        outside_login["sessionId"].as_str().unwrap(),
        &team.id,
        session,
    );
    let wrong_team = principal(&owner.id, login_id, &other.id, session);
    let mismatched_sender = principal(&outsider.id, login_id, &team.id, session);
    for (request, expected) in [
        (
            call(login["token"].as_str().unwrap(), &owner_principal),
            StatusCode::UNAUTHORIZED,
        ),
        (
            call("fixture-secret", &Value::Null),
            StatusCode::UNAUTHORIZED,
        ),
        (call("fixture-secret", &outside), StatusCode::FORBIDDEN),
        (
            call("fixture-secret", &mismatched_sender),
            StatusCode::UNAUTHORIZED,
        ),
        (call("fixture-secret", &wrong_team), StatusCode::NOT_FOUND),
    ] {
        assert_eq!(test::call_service(&app, request).await.status(), expected);
    }
    sdk.override_gate(rollout::GATE, false, Some(&team.id));
    assert_eq!(
        test::call_service(&app, call("fixture-secret", &owner_principal))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    sdk.override_gate(rollout::GATE, true, Some(&team.id));
    store
        .lock_cloud_session(&team.id, session)
        .await
        .unwrap()
        .set_archived(true)
        .await
        .unwrap();
    assert_eq!(
        test::call_service(&app, call("fixture-secret", &owner_principal))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    store
        .lock_cloud_session(&team.id, session)
        .await
        .unwrap()
        .delete()
        .await
        .unwrap();
    assert_eq!(
        test::call_service(&app, call("fixture-secret", &owner_principal))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    store
        .revoke_user_sessions(&owner.id, Some(login_id))
        .await
        .unwrap();
    assert_eq!(
        test::call_service(&app, call("fixture-secret", &owner_principal))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    drop(app);
    store.close().await.unwrap();
    database.close().await;
}
