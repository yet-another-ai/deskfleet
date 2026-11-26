use super::*;
use crate::{AppState, auth::config::AuthConfig, config::ServerConfig};
use actix_web::test;

#[actix_web::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL; Stripe is replaced by a local HTTP fixture"]
async fn public_catalog_reflects_deployment_and_shares_the_paid_prices() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let provider_state = web::Data::new(Mutex::new(Provider::default()));
    let server_state = provider_state.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(server_state.clone())
            .default_service(web::route().to(provider))
    })
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    let task = actix_web::rt::spawn(server);
    let url = "https://web.example.test";
    for hosted in [false, true] {
        let mut state = AppState::new(ServerConfig {
            bind_addrs: Vec::new(),
            database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
            public_url: url.into(),
            web_origins: Vec::new(),
            auth: AuthConfig::development(url),
            billing: BillingConfig {
                hosted,
                ..Default::default()
            },
            github_app: None,
            stun_urls: Vec::new(),
            turn_urls: Vec::new(),
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap();
        // Install the fixture only on the request path; background workers have no Stripe client.
        let mut config = if hosted {
            fixture_config()
        } else {
            BillingConfig::default()
        };
        config.enterprise_contact_email = Some("sales@example.test".into());
        state.billing = BillingService::new(config, url.into()).unwrap();
        state.billing.api_base = format!("http://{address}/v1");
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(state))
                .configure(crate::configure),
        )
        .await;
        let get = || test::TestRequest::get().uri("/api/pricing").to_request();
        let catalog: Value = test::call_and_read_body_json(&app, get()).await;
        if hosted {
            let plans: Vec<_> = catalog["planCatalog"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["plan"].as_str().unwrap())
                .collect();
            assert_eq!(plans, ["free", "go", "pro", "enterprise"]);
            assert_eq!(catalog["enterpriseContactEmail"], "sales@example.test");
            assert_eq!(catalog["paymentsAvailable"], true);
            assert_eq!(
                catalog["prices"],
                json!([
                    {"plan":"go","interval":"month","unitAmount":500,"currency":"usd"},
                    {"plan":"pro","interval":"month","unitAmount":1500,"currency":"usd"},
                    {"plan":"go","interval":"year","unitAmount":5000,"currency":"usd"},
                    {"plan":"pro","interval":"year","unitAmount":15000,"currency":"usd"}
                ])
            );
            let second: Value = test::call_and_read_body_json(&app, get()).await;
            assert_eq!(second, catalog);
            assert_eq!(provider_state.lock().unwrap().price_reads.len(), 4);
        } else {
            assert_eq!(
                catalog,
                json!({
                    "planCatalog": [], "prices": [], "paymentsAvailable":false,"enterpriseContactEmail":null
                })
            );
            assert!(provider_state.lock().unwrap().price_reads.is_empty());
        }
    }
    handle.stop(true).await;
    task.await.unwrap().unwrap();
}
