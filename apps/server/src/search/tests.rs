use actix_web::{App, http::StatusCode, test, web};
use serde_json::{Value, json};

use crate::{AppState, config::ServerConfig, configure};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_http_search_and_schedule_snapshots_are_authorized() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: crate::auth::config::AuthConfig::development("https://control.test"),
            billing: Default::default(),
            github_app: None,
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let suffix = uuid::Uuid::new_v4();
    let owner = state
        .store
        .verified_user(&format!("search-{suffix}@fixture.test"), "Owner")
        .await
        .unwrap();
    let outsider = state
        .store
        .verified_user(&format!("search-outside-{suffix}@fixture.test"), "Outside")
        .await
        .unwrap();
    let login = state.store.new_session(&owner.id).await.unwrap();
    let outside_login = state.store.new_session(&outsider.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let outside_token = outside_login["token"].as_str().unwrap();
    let team = state
        .store
        .create_team(&owner.id, "Search API fixture")
        .await
        .unwrap();
    let (machine, machine_token) = state
        .store
        .enroll(
            &owner.id,
            &team.id,
            "Offline worker",
            &suffix.to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    state
        .store
        .save_catalog(
            &machine.id,
            json!({"machineId":"1","workspaces":[{"id":"1","name":"Workspace"}],"sessionIds":[]}),
            json!({}),
        )
        .await
        .unwrap();
    let search_path = format!("/api/teams/{}/search?q=release", team.id);
    let schedules_path = format!("/api/machines/{}/schedules", machine.id);
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;

    for path in [&search_path, &schedules_path] {
        let response =
            test::call_service(&app, test::TestRequest::get().uri(path).to_request()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(path)
                .insert_header(("Authorization", format!("Bearer {outside_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let tasks = json!([{
        "id":"task-1","title":"Weekly release","prompt":"Check the release notes","workspaceId":"1","enabled":false,
        "target":{"kind":"new","provider":"codex","context":"directory"},"trigger":{"kind":"manual"},
        "createdAt":"2026-10-31T00:00:00.000Z","updatedAt":"2026-10-31T00:00:00.000Z","runs":[]
    }]);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/daemon/schedules")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(json!({"tasks":tasks}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/daemon/schedules")
            .insert_header(("Authorization", format!("Bearer {machine_token}")))
            .set_json(json!({"tasks":tasks}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&schedules_path)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: Value = test::read_body_json(response).await;
    assert_eq!(snapshot["tasks"], tasks);
    assert!(snapshot["lastObservedAt"].is_string());
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&search_path)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let results: Value = test::read_body_json(response).await;
    assert_eq!(results["results"].as_array().unwrap().len(), 1);
    assert_eq!(results["results"][0]["kind"], "schedule");
    assert_eq!(results["results"][0]["machineId"], machine.id);
    assert_eq!(results["results"][0]["resourceId"], "task-1");

    for query in [
        "q=release&kind=unknown",
        "q=release&limit=0",
        "q=release&cursor=invalid",
        "q=release&unexpected=true",
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/teams/{}/search?{query}", team.id))
                .insert_header(("Authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/daemon/schedules")
            .insert_header(("Authorization", format!("Bearer {machine_token}")))
            .set_json(json!({"tasks":[]}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&search_path)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request(),
    )
    .await;
    let results: Value = test::read_body_json(response).await;
    assert_eq!(results["results"], json!([]));
}
