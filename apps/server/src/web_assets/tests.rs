use std::{fs, path::PathBuf};

use actix_web::{
    App,
    http::{Method, StatusCode, header},
    test as http_test,
};

use super::WebAssets;

const INDEX: &str = "<!doctype html><html><body>DeskFleet Web</body></html>";
const SCRIPT: &str = "console.log('DeskFleet')";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

struct Fixture {
    parent: PathBuf,
    assets: WebAssets,
}

impl Fixture {
    fn new() -> Self {
        let parent = std::env::temp_dir().join(format!("deskfleet-web-{}", uuid::Uuid::new_v4()));
        let directory = parent.join("web");
        fs::create_dir_all(directory.join("assets")).unwrap();
        fs::create_dir_all(directory.join("api")).unwrap();
        fs::write(directory.join("index.html"), INDEX).unwrap();
        for path in [
            "assets/app-a1b2c3d4.js",
            "assets/chevron-down-BEOiB5L-.js",
            "assets/styles-Cog8TC2_.css",
            "assets/app-a1b2.js",
            "assets/config.json",
            "app-a1b2c3d4.js",
            "favicon.ico",
        ] {
            fs::write(directory.join(path), SCRIPT).unwrap();
        }
        // These names must never override the API or health routes.
        fs::write(directory.join("api/missing"), "not an API response").unwrap();
        fs::write(directory.join("healthz"), "not health JSON").unwrap();
        fs::write(parent.join("private.txt"), "outside the Web root").unwrap();
        fs::write(directory.join(".env"), "not a public asset").unwrap();
        let assets = WebAssets::load(directory).unwrap();
        Self { parent, assets }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent);
    }
}

#[actix_web::test]
async fn page_entry_points_serve_revalidatable_html_and_head() {
    let fixture = Fixture::new();
    let app = http_test::init_service(
        App::new()
            .configure(crate::configure)
            .configure(|config| fixture.assets.configure(config)),
    )
    .await;
    for path in [
        "/",
        "/index.html",
        "/auth/account",
        "/auth/verify?token=example",
    ] {
        let response =
            http_test::call_service(&app, http_test::TestRequest::get().uri(path).to_request())
                .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
        let etag = response.headers().get(header::ETAG).unwrap().clone();
        assert_eq!(http_test::read_body(response).await, INDEX);

        let response = http_test::call_service(
            &app,
            http_test::TestRequest::default()
                .method(Method::HEAD)
                .uri(path)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );

        let response = http_test::call_service(
            &app,
            http_test::TestRequest::get()
                .uri(path)
                .insert_header((header::IF_NONE_MATCH, etag))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED, "{path}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
        assert!(http_test::read_body(response).await.is_empty());
    }
}

#[actix_web::test]
async fn real_assets_use_content_hash_cache_policy_and_keep_validators() {
    let fixture = Fixture::new();
    let app = http_test::init_service(
        App::new()
            .configure(crate::configure)
            .configure(|config| fixture.assets.configure(config)),
    )
    .await;
    for (path, cache_control, content_type) in [
        (
            "/assets/app-a1b2c3d4.js?download=1",
            IMMUTABLE,
            "javascript",
        ),
        ("/assets/chevron-down-BEOiB5L-.js", IMMUTABLE, "javascript"),
        ("/assets/styles-Cog8TC2_.css", IMMUTABLE, "text/css"),
        ("/assets/app-a1b2.js", "no-cache", "javascript"),
        ("/assets/config.json", "no-cache", "application/json"),
        ("/app-a1b2c3d4.js", "no-cache", "javascript"),
        ("/favicon.ico", "no-cache", "image/"),
    ] {
        let response =
            http_test::call_service(&app, http_test::TestRequest::get().uri(path).to_request())
                .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            cache_control,
            "{path}"
        );
        assert!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap()
                .contains(content_type),
            "{path}"
        );
        let etag = response.headers().get(header::ETAG).unwrap().clone();
        assert!(response.headers().contains_key(header::LAST_MODIFIED));
        assert_eq!(http_test::read_body(response).await, SCRIPT);

        let response = http_test::call_service(
            &app,
            http_test::TestRequest::default()
                .method(Method::HEAD)
                .uri(path)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            cache_control,
            "{path}"
        );
        assert_eq!(response.headers().get(header::ETAG).unwrap(), &etag);

        let response = http_test::call_service(
            &app,
            http_test::TestRequest::get()
                .uri(path)
                .insert_header((header::IF_NONE_MATCH, etag))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED, "{path}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            cache_control,
            "{path}"
        );
        assert!(http_test::read_body(response).await.is_empty());
    }
}

#[actix_web::test]
async fn api_and_health_routes_take_priority_over_web_files() {
    let fixture = Fixture::new();
    let app = http_test::init_service(
        App::new()
            .configure(crate::configure)
            .configure(|config| fixture.assets.configure(config)),
    )
    .await;
    let response = http_test::call_service(
        &app,
        http_test::TestRequest::get().uri("/healthz").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::CACHE_CONTROL));
    let body: serde_json::Value = http_test::read_body_json(response).await;
    assert_eq!(body["status"], "ok");
    assert_eq!(body["protocol_version"], 1);
    for path in ["/api/missing", "/api", "/api/"] {
        let response =
            http_test::call_service(&app, http_test::TestRequest::get().uri(path).to_request())
                .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        assert!(http_test::read_body(response).await.is_empty());
    }
}

#[actix_web::test]
async fn missing_assets_and_non_page_paths_do_not_fall_back_to_html() {
    let fixture = Fixture::new();
    let app = http_test::init_service(
        App::new()
            .configure(crate::configure)
            .configure(|config| fixture.assets.configure(config)),
    )
    .await;
    for path in [
        "/assets/missing-a1b2c3d4.js",
        "/assets/missing.js",
        "/missing.png",
        "/assets/",
        "/unknown",
    ] {
        let response =
            http_test::call_service(&app, http_test::TestRequest::get().uri(path).to_request())
                .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store",
            "{path}"
        );
        assert_ne!(http_test::read_body(response).await, INDEX);
    }
}

#[actix_web::test]
async fn writes_and_private_paths_cannot_read_the_web_bundle_or_parent_directory() {
    let fixture = Fixture::new();
    let app = http_test::init_service(
        App::new()
            .configure(crate::configure)
            .configure(|config| fixture.assets.configure(config)),
    )
    .await;
    for path in [
        "/",
        "/auth/account",
        "/index.html",
        "/assets/app-a1b2c3d4.js",
    ] {
        let response =
            http_test::call_service(&app, http_test::TestRequest::post().uri(path).to_request())
                .await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED, "{path}");
        assert_ne!(http_test::read_body(response).await, INDEX);
    }
    for path in [
        "/../private.txt",
        "/%2e%2e/private.txt",
        "/assets/../../private.txt",
        "/.env",
    ] {
        let response =
            http_test::call_service(&app, http_test::TestRequest::get().uri(path).to_request())
                .await;
        assert!(response.status().is_client_error(), "{path}");
        assert_ne!(http_test::read_body(response).await, "outside the Web root");
    }
}

#[actix_web::test]
async fn without_web_assets_only_api_routes_are_registered() {
    let app = http_test::init_service(App::new().configure(crate::configure)).await;
    for path in ["/", "/auth/account", "/assets/app-a1b2c3d4.js"] {
        let response =
            http_test::call_service(&app, http_test::TestRequest::get().uri(path).to_request())
                .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}

#[test]
fn configured_web_directory_requires_a_readable_index_file() {
    let fixture = Fixture::new();
    let missing = fixture.parent.join("missing");
    assert!(WebAssets::load(missing).is_err());
    fs::remove_file(fixture.assets.directory.join("index.html")).unwrap();
    let error = WebAssets::load(fixture.assets.directory.clone()).unwrap_err();
    assert!(error.to_string().contains("DESKFLEET_WEB_DIRECTORY"));
    fs::create_dir(fixture.assets.directory.join("index.html")).unwrap();
    assert!(WebAssets::load(fixture.assets.directory.clone()).is_err());
}
