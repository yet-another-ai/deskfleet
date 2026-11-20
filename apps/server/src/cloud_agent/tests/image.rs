use super::*;

#[actix_web::test]
#[ignore = "run scripts/smoke-super-agent-image.ts with a built image"]
async fn create_empty_session() {
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
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(state))
            .configure(crate::configure),
    )
    .await;
    let sessions = format!("/api/teams/{}/super-agent/sessions", team.id);
    let create = test::TestRequest::post()
        .uri(&sessions)
        .insert_header(("Authorization", auth.as_str()))
        .set_json(json!({"operationId": uuid::Uuid::new_v4().to_string()}))
        .to_request();
    let response = test::call_service(&app, create).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let created: Value = test::read_body_json(response).await;
    let id = created["sessionId"].as_str().unwrap();
    let history = test::TestRequest::get()
        .uri(&format!("{sessions}/{id}/stream"))
        .insert_header(("Authorization", auth.as_str()))
        .to_request();
    let response = test::call_service(&app, history).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key("x-eve-stream-version"));
    test::read_body(response).await;
    database.close().await;
}
