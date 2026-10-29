//! Owner authority is evaluated from current Team membership on every request.
use crate::{AppState, config::ServerConfig, configure};
use actix_web::{App, http::StatusCode, test, web};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_http_owner_controls_billing_and_transfers_authority() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: crate::auth::config::AuthConfig::development("https://control.test"),
            billing: Default::default(),
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
        .verified_user(&format!("owner-{suffix}@fixture.test"), "Owner")
        .await
        .unwrap();
    let admin = state
        .store
        .verified_user(&format!("admin-{suffix}@fixture.test"), "Admin")
        .await
        .unwrap();
    let member = state
        .store
        .verified_user(&format!("member-{suffix}@fixture.test"), "Member")
        .await
        .unwrap();
    let owner_login = state.store.new_session(&owner.id).await.unwrap();
    let admin_login = state.store.new_session(&admin.id).await.unwrap();
    let member_login = state.store.new_session(&member.id).await.unwrap();
    let owner_token = owner_login["token"].as_str().unwrap();
    let admin_token = admin_login["token"].as_str().unwrap();
    let member_token = member_login["token"].as_str().unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    macro_rules! call {
        ($method:ident, $path:expr, $token:expr, $body:expr) => {
            test::call_service(
                &app,
                test::TestRequest::$method()
                    .uri($path)
                    .insert_header(("Authorization", format!("Bearer {}", $token)))
                    .set_json($body)
                    .to_request(),
            )
            .await
        };
    }
    let team: Value = test::read_body_json(call!(
        post,
        "/api/teams",
        owner_token,
        &json!({"name":"Owner authority"})
    ))
    .await;
    assert_eq!(team["role"], "owner");
    let team_id = team["id"].as_str().unwrap();
    let base = format!("/api/teams/{team_id}");
    for (user, role) in [(&admin, "admin"), (&member, "member")] {
        let invite = state
            .store
            .invite(&owner.id, team_id, user.email.as_deref().unwrap(), role)
            .await
            .unwrap();
        state
            .store
            .accept_invite(&user.id, invite["token"].as_str().unwrap())
            .await
            .unwrap();
    }
    for (token, can_manage) in [
        (owner_token, true),
        (admin_token, false),
        (member_token, false),
    ] {
        let response = call!(get, &format!("{base}/billing"), token, &json!({}));
        assert_eq!(response.status(), StatusCode::OK);
        let billing: Value = test::read_body_json(response).await;
        assert_eq!(billing["canManageBilling"], can_manage);
        for operation in ["checkout", "portal"] {
            let response = call!(
                post,
                &format!("{base}/billing/{operation}"),
                token,
                &if operation == "checkout" {
                    json!({"plan":"go","requestId":uuid::Uuid::new_v4().to_string()})
                } else {
                    json!({})
                }
            );
            // The Owner reaches the disabled provider; other roles are denied first.
            assert_eq!(
                response.status(),
                if can_manage {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::FORBIDDEN
                }
            );
        }
    }
    // Admin retains ordinary Team management, but cannot delete or take ownership.
    assert_eq!(
        call!(
            patch,
            &base,
            admin_token,
            &json!({"name":"Renamed by admin"})
        )
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(delete, &base, admin_token, &json!({})).status(),
        StatusCode::FORBIDDEN
    );
    for token in [admin_token, member_token] {
        assert_eq!(
            call!(
                post,
                &format!("{base}/ownership"),
                token,
                &json!({"userId":admin.id})
            )
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    let owner_member = format!("{base}/members/{}", owner.id);
    assert_eq!(
        call!(delete, &owner_member, admin_token, &json!({})).status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        call!(patch, &owner_member, owner_token, &json!({"role":"admin"})).status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        call!(
            post,
            &format!("{base}/ownership"),
            owner_token,
            &json!({"userId":member.id,"role":"owner"})
        )
        .status(),
        StatusCode::BAD_REQUEST
    );
    let response = call!(
        post,
        &format!("{base}/ownership"),
        owner_token,
        &json!({"userId":member.id})
    );
    assert_eq!(response.status(), StatusCode::OK);
    for (token, role, can_manage) in [(owner_token, "admin", false), (member_token, "owner", true)]
    {
        let teams: Value = test::read_body_json(call!(get, "/api/teams", token, &json!({}))).await;
        let team = teams
            .as_array()
            .unwrap()
            .iter()
            .find(|team| team["id"] == team_id)
            .unwrap();
        assert_eq!(team["role"], role);
        let billing: Value =
            test::read_body_json(call!(get, &format!("{base}/billing"), token, &json!({}))).await;
        assert_eq!(billing["canManageBilling"], can_manage);
    }
    assert_eq!(
        call!(
            post,
            &format!("{base}/billing/portal"),
            owner_token,
            &json!({})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            post,
            &format!("{base}/billing/portal"),
            member_token,
            &json!({})
        )
        .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call!(
            post,
            &format!("{base}/ownership"),
            owner_token,
            &json!({"userId":owner.id})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
}
