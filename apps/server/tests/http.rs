use std::io::Read;

use actix_web::{
    App,
    http::{StatusCode, header},
    middleware::Compress,
    test,
};
use deskfleet_protocol::PROTOCOL_VERSION;
use deskfleet_server::configure;
use serde_json::{Value, json};

#[actix_web::test]
async fn healthz_returns_the_liveness_contract() {
    let app = test::init_service(App::new().wrap(Compress::default()).configure(configure)).await;
    let response =
        test::call_service(&app, test::TestRequest::get().uri("/healthz").to_request()).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::CONTENT_ENCODING));
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "application/json"
    );
    let body: Value = test::read_body_json(response).await;
    assert_eq!(
        body,
        json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol_version": PROTOCOL_VERSION,
        }),
    );

    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/healthz")
            .insert_header((header::ACCEPT_ENCODING, "gzip"))
            .to_request(),
    )
    .await;
    assert_eq!(
        response.headers().get(header::CONTENT_ENCODING).unwrap(),
        "gzip"
    );
    let encoded = test::read_body(response).await;
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(encoded.as_ref())
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&decoded).unwrap(), body);
}
