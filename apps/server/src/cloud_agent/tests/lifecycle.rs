use super::*;
use actix_web::http::Method;
use tokio::sync::Notify;

#[derive(Default)]
struct Runtime {
    sending: Notify,
    release: Notify,
    cancels: AtomicUsize,
    ends: AtomicUsize,
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn hosted_lifecycle_orders_archive_after_delivery_and_preserves_the_tombstone() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let runtime = web::Data::new(Runtime::default());
    let upstream = runtime.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(upstream.clone())
            .route(
                "/eve/v1/session",
                web::post().to(|| async {
                    HttpResponse::Accepted().json(json!({"sessionId":"lifecycle"}))
                }),
            )
            .route(
                "/eve/v1/session/lifecycle",
                web::post().to(|r: web::Data<Runtime>| async move {
                    r.sending.notify_one();
                    r.release.notified().await;
                    HttpResponse::Accepted().json(json!({"deliveryId":"delivery"}))
                }),
            )
            .route(
                "/eve/v1/session/lifecycle/cancel",
                web::post().to(|r: web::Data<Runtime>| async move {
                    if r.cancels.fetch_add(1, Ordering::SeqCst) > 0 {
                        return HttpResponse::Conflict().json(json!({"code":"session_stranded"}));
                    }
                    HttpResponse::Accepted().finish()
                }),
            )
            .route(
                "/eve/v1/session/lifecycle/end",
                web::post().to(|r: web::Data<Runtime>| async move {
                    match r.ends.fetch_add(1, Ordering::SeqCst) {
                        0 => HttpResponse::ServiceUnavailable().finish(),
                        1 => HttpResponse::Conflict().json(json!({"code":"session_stranded"})),
                        _ => HttpResponse::Conflict().json(json!({"code":"session_not_active"})),
                    }
                }),
            )
            .route(
                "/eve/v1/session/lifecycle/stream",
                web::get().to(|| async { HttpResponse::Ok().body("saved history") }),
            )
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let (database, state, sdk) = fixture_state(address).await;
    let store = state.store.clone();
    let user = store
        .verified_user("lifecycle@fixture.test", "User")
        .await
        .unwrap();
    store.grant_site_admin(&user.id).await.unwrap();
    let mut limits = store.plan_limits(Plan::Free).await.unwrap();
    limits.super_agent_tokens = Some(100);
    store
        .update_plan_limits(&user.id, Plan::Free, limits)
        .await
        .unwrap();
    store.revoke_site_admin(&user.id).await.unwrap();
    let login = store.new_session(&user.id).await.unwrap();
    let token = format!("Bearer {}", login["token"].as_str().unwrap());
    let team = store
        .create_team(&user.id, "Super Agent lifecycle")
        .await
        .unwrap();
    let other = store.create_team(&user.id, "Other").await.unwrap();
    sdk.override_gate(rollout::GATE, true, Some(&team.id));
    sdk.override_gate(rollout::GATE, true, Some(&other.id));
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(state))
            .configure(crate::configure),
    )
    .await;
    let base = format!("/api/teams/{}/super-agent/sessions", team.id);
    let path = format!("{base}/lifecycle");
    let request = |method: Method, path: &str| {
        test::TestRequest::default()
            .method(method)
            .uri(path)
            .insert_header(("Authorization", token.as_str()))
    };
    let action = |suffix: &str| request(Method::POST, &format!("{path}/{suffix}")).to_request();
    let create = json!({"operationId":uuid::Uuid::new_v4()});
    let send = |operation_id: uuid::Uuid| {
        request(Method::POST, &format!("{path}/messages"))
            .set_json(json!({"operationId":operation_id,"message":"hello"}))
            .to_request()
    };

    assert_eq!(
        test::call_service(
            &app,
            request(Method::POST, &base).set_json(&create).to_request()
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let cross_team = format!("/api/teams/{}/super-agent/sessions/lifecycle", other.id);
    for (method, suffix) in [
        (Method::POST, "/archive"),
        (Method::POST, "/restore"),
        (Method::DELETE, ""),
    ] {
        assert_eq!(
            test::call_service(
                &app,
                request(method, &format!("{cross_team}{suffix}")).to_request()
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(runtime.ends.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.cancels.load(Ordering::SeqCst), 0);

    // Hold Eve's send acknowledgement while the other client archives the conversation.
    let send_and_archive = async {
        runtime.sending.notified().await;
        let archive = test::call_service(&app, action("archive"));
        tokio::pin!(archive);
        tokio::select! {
            _ = &mut archive => panic!("archive overtook an in-flight delivery"),
            () = tokio::time::sleep(Duration::from_millis(50)) => {},
        }
        runtime.release.notify_one();
        archive.await
    };
    let delivered_operation = uuid::Uuid::new_v4();
    let (sent, archived) = tokio::time::timeout(Duration::from_secs(10), async {
        futures_util::join!(
            test::call_service(&app, send(delivered_operation)),
            send_and_archive
        )
    })
    .await
    .unwrap();
    assert_eq!(sent.status(), StatusCode::ACCEPTED);
    assert_eq!(archived.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        test::call_service(&app, action("archive")).await.status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(runtime.cancels.load(Ordering::SeqCst), 1);
    let listed: Value =
        test::call_and_read_body_json(&app, request(Method::GET, &base).to_request()).await;
    assert_eq!(listed[0]["archived"], true);
    let replay: Value = test::call_and_read_body_json(
        &app,
        request(Method::POST, &base).set_json(&create).to_request(),
    )
    .await;
    assert_eq!(replay, json!({"sessionId":"lifecycle"}));
    assert_eq!(
        test::call_service(&app, send(uuid::Uuid::new_v4()))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let history = request(Method::GET, &format!("{path}/stream")).to_request();
    assert_eq!(
        test::call_and_read_body(&app, history).await,
        "saved history"
    );
    assert_eq!(
        test::call_service(&app, action("restore")).await.status(),
        StatusCode::NO_CONTENT
    );
    let listed: Value =
        test::call_and_read_body_json(&app, request(Method::GET, &base).to_request()).await;
    assert_eq!(listed[0]["archived"], false);

    // Old workflows stranded by an Eve upgrade can be archived. Ending still
    // requires confirmation that Eve retired the workflow.
    assert_eq!(
        test::call_service(&app, action("archive")).await.status(),
        StatusCode::NO_CONTENT
    );
    let delete = || request(Method::DELETE, &path).to_request();
    assert_eq!(
        test::call_service(&app, delete()).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        test::call_service(&app, delete()).await.status(),
        StatusCode::CONFLICT
    );
    assert!(
        store
            .owns_cloud_session(&team.id, "lifecycle")
            .await
            .unwrap()
    );
    // Concurrent attempts share the committed deletion, including a later retry
    // by a client that lost its response.
    let (first, second) = futures_util::join!(
        test::call_service(&app, delete()),
        test::call_service(&app, delete()),
    );
    assert_eq!(first.status(), StatusCode::NO_CONTENT);
    assert_eq!(second.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        test::call_service(&app, delete()).await.status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(runtime.ends.load(Ordering::SeqCst), 3);
    let listed: Value =
        test::call_and_read_body_json(&app, request(Method::GET, &base).to_request()).await;
    assert_eq!(listed, json!([]));
    for missing in [
        send(delivered_operation),
        action("archive"),
        action("restore"),
        request(Method::DELETE, &cross_team).to_request(),
        request(Method::DELETE, &format!("{base}/missing")).to_request(),
        request(Method::GET, &format!("{path}/stream")).to_request(),
        request(Method::POST, &base).set_json(create).to_request(),
    ] {
        assert_eq!(
            test::call_service(&app, missing).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    let cursor = store
        .claim_cloud_meter(10000)
        .await
        .unwrap()
        .expect("retain usage accounting after deletion");
    assert_eq!(cursor.session_id, "lifecycle");
    drop(app);
    handle.stop(true).await;
    store.close().await.unwrap();
    database.close().await;
}
