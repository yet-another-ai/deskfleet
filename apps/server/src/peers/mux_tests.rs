//! Mux negotiation retains the existing actor, registration, and grant boundary.

use super::*;

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn mux_requires_daemon_support_and_machine_lists_confirm_server_support() {
    let fixture = Fixture::new().await;
    let create = || peers::Create {
        team_id: fixture.team.clone(),
        machine_id: fixture.machine.clone(),
        purpose: "mux".into(),
    };
    let unsupported = peers::create(
        request(&fixture.token),
        fixture.a.clone(),
        web::Json(create()),
    )
    .await
    .unwrap_err();
    assert_eq!(unsupported.code, "mux_unsupported");

    fixture
        .a
        .store
        .set_machine_capabilities(
            &fixture.registration,
            json!({"agent":true,"mux":"fixed4-v1"}),
        )
        .await
        .unwrap();
    let machines = crate::api::machines(
        request(&fixture.token),
        fixture.a.clone(),
        fixture.team.clone().into(),
    )
    .await
    .unwrap();
    assert_eq!(machines[0]["capabilities"]["mux"], "fixed4-v1");
    assert_eq!(machines[0]["capabilities"]["muxServer"], "fixed4-v1");
    let response = peers::create(
        request(&fixture.token),
        fixture.a.clone(),
        web::Json(create()),
    )
    .await
    .unwrap();
    let grant = &response["authorization"];
    assert_eq!(grant["purpose"], "mux");
    assert_eq!(grant["actor"]["deviceId"], fixture.login);
    assert_eq!(grant["teamId"], fixture.team);
    assert_eq!(grant["targetMachine"]["id"], fixture.machine);
    assert_eq!(
        grant["actions"],
        json!([
            "agent:read",
            "agent:execute",
            "git:read",
            "terminal:read",
            "terminal:write",
            "files:read",
            "files:write"
        ]),
    );
    let peer = response["peerId"].as_str().unwrap();
    let persisted = fixture.a.store.peer(peer, &fixture.login).await.unwrap();
    assert_eq!(persisted.purpose, "mux");
    assert!(fixture.a.store.peer(peer, "another-login").await.is_err());

    // A daemon cannot forge server support for an unsupported transport profile.
    fixture
        .a
        .store
        .set_machine_capabilities(
            &fixture.registration,
            json!({"mux":"future","muxServer":"fixed4-v1"}),
        )
        .await
        .unwrap();
    let machines = crate::api::machines(
        request(&fixture.token),
        fixture.a.clone(),
        fixture.team.clone().into(),
    )
    .await
    .unwrap();
    assert!(machines[0]["capabilities"].get("muxServer").is_none());
    fixture.close().await;
}
