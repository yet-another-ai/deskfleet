use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, dev::ServerHandle, web};
use std::{collections::VecDeque, net::TcpListener, sync::Mutex};

struct Reply {
    status: StatusCode,
    body: Value,
}

#[derive(Debug)]
struct Request {
    path: String,
    authorization: String,
    body: Value,
}

#[derive(Default)]
struct Provider {
    replies: VecDeque<Reply>,
    requests: Vec<Request>,
}

async fn provider(
    request: HttpRequest,
    body: web::Json<Value>,
    state: web::Data<Mutex<Provider>>,
) -> HttpResponse {
    assert_eq!(request.method(), "POST");
    let mut state = state.lock().unwrap();
    state.requests.push(Request {
        path: request.uri().path().into(),
        authorization: request
            .headers()
            .get("Authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        body: body.into_inner(),
    });
    let reply = state.replies.pop_front().expect("unexpected provider call");
    HttpResponse::build(reply.status).json(reply.body)
}

struct Fixture {
    client: Client,
    state: web::Data<Mutex<Provider>>,
    server: ServerHandle,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Fixture {
    async fn new() -> Self {
        crate::initialize_tls_provider();
        // Prefer IPv6 loopback to avoid WSL's IPv4 localhost port forwarding.
        let listener = TcpListener::bind("[::1]:0")
            .or_else(|_| TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        let state = web::Data::new(Mutex::new(Provider::default()));
        let server_state = state.clone();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(server_state.clone())
                .route(
                    "/ready",
                    web::get().to(|| async { HttpResponse::Ok().finish() }),
                )
                .default_service(web::route().to(provider))
        })
        .workers(1)
        .listen(listener)
        .unwrap()
        .run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        let mut client = Client::new().unwrap();
        client.credentials_url = format!("http://{address}/v1/turn/keys");
        client.analytics_url = format!("http://{address}/client/v4/graphql");
        // WSL localhost forwarding can briefly refuse a newly bound listener.
        // Wait for the actual HTTP service rather than assuming bind is ready.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if client
                    .http
                    .get(format!("http://{address}/ready"))
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("local Cloudflare fixture did not become ready");
        Self {
            client,
            state,
            server: handle,
            task,
        }
    }

    fn reply(&self, status: StatusCode, body: Value) {
        self.state
            .lock()
            .unwrap()
            .replies
            .push_back(Reply { status, body });
    }

    async fn stop(self) {
        assert!(self.state.lock().unwrap().replies.is_empty());
        self.server.stop(false).await;
        self.task.await.unwrap().unwrap();
    }
}

fn usage_response(bytes: Value) -> Value {
    json!({
        "data": {"viewer": {"accounts": [{
            "callsTurnUsageAdaptiveGroups": [{"sum": {"egressBytes": bytes}}]
        }]}},
        "errors": null
    })
}

fn assert_provider_error(error: ApiError) {
    assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error.code, "turn_service_unavailable");
    assert_eq!(error.to_string(), "Cloudflare TURN service is unavailable");
    assert!(!format!("{error:?}").contains("private-provider-secret"));
}

#[actix_web::test]
async fn credentials_preserve_each_relay_identity_and_exclude_provider_stun() {
    let fixture = Fixture::new().await;
    fixture.reply(
        StatusCode::CREATED,
        json!({"iceServers": [
            {"urls": ["stun:stun.cloudflare.com:3478"]},
            {"urls": ["turn:turn.cloudflare.com:3478?transport=udp", "stun:ignore.test"],
             "username": "first-user", "credential": "first-password"},
            {"urls": ["turns:turn.cloudflare.com:443?transport=tcp"],
             "username": "second-user", "credential": "second-password"}
        ]}),
    );
    let servers = fixture
        .client
        .generate("key-one", "turn-token", "connection-one", 86400)
        .await
        .unwrap();
    assert_eq!(servers.len(), 2);
    assert_eq!(
        servers[0].urls,
        ["turn:turn.cloudflare.com:3478?transport=udp"]
    );
    assert_eq!(servers[0].username.as_deref(), Some("first-user"));
    assert_eq!(servers[0].credential.as_deref(), Some("first-password"));
    assert_eq!(
        servers[1].urls,
        ["turns:turn.cloudflare.com:443?transport=tcp"]
    );
    assert_eq!(servers[1].username.as_deref(), Some("second-user"));
    assert_eq!(servers[1].credential.as_deref(), Some("second-password"));
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.requests.len(), 1);
        let request = &state.requests[0];
        assert_eq!(
            request.path,
            "/v1/turn/keys/key-one/credentials/generate-ice-servers"
        );
        assert_eq!(request.authorization, "Bearer turn-token");
        assert_eq!(
            request.body,
            json!({"ttl": 86400, "customIdentifier": "connection-one"})
        );
    }
    fixture.stop().await;
}

#[actix_web::test]
async fn credentials_reject_provider_errors_and_incomplete_relay_credentials() {
    let fixture = Fixture::new().await;
    for (status, body) in [
        (
            StatusCode::UNAUTHORIZED,
            json!({"error": "private-provider-secret"}),
        ),
        (StatusCode::OK, json!({"private-provider-secret": true})),
        (StatusCode::OK, json!({"iceServers": []})),
        (
            StatusCode::OK,
            json!({"iceServers": [{"urls": ["stun:stun.cloudflare.com:3478"]}]}),
        ),
        (
            StatusCode::OK,
            json!({"iceServers": [{"urls": ["turn:relay.test"], "username": "user"}]}),
        ),
        (
            StatusCode::OK,
            json!({"iceServers": [{"urls": ["turn:relay.test"], "username": "", "credential": "private-provider-secret"}]}),
        ),
    ] {
        fixture.reply(status, body);
        assert_provider_error(
            fixture
                .client
                .generate("key", "private-provider-secret", "peer", 86400)
                .await
                .unwrap_err(),
        );
    }
    fixture.stop().await;
}

#[actix_web::test]
async fn analytics_requests_one_identifier_and_returns_cumulative_egress() {
    let fixture = Fixture::new().await;
    let identifier = "connection\"\\\nidentifier";
    // Repeated provider totals remain totals; the persistence layer owns deltas.
    for _ in 0..2 {
        fixture.reply(StatusCode::OK, usage_response(json!(123456)));
        assert_eq!(
            fixture
                .client
                .usage(
                    "account-one",
                    "key-one",
                    "analytics-token",
                    identifier,
                    0,
                    60000
                )
                .await
                .unwrap()
                .egress_bytes,
            123456
        );
    }
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.requests.len(), 2);
        for request in &state.requests {
            assert_eq!(request.path, "/client/v4/graphql");
            assert_eq!(request.authorization, "Bearer analytics-token");
            let query = request.body["query"].as_str().unwrap();
            assert!(query.contains("accountTag: \"account-one\""));
            assert!(query.contains("keyId: \"key-one\""));
            assert!(query.contains(&format!("customIdentifier: {}", json!(identifier))));
            assert!(query.contains("datetime_geq: \"1970-01-01T00:00:00.000Z\""));
            assert!(query.contains("datetime_lt: \"1970-01-01T00:01:00.000Z\""));
            assert!(query.contains("limit: 1"));
            assert!(query.contains("sum { egressBytes }"));
            assert!(query.contains("daily: callsTurnUsageAdaptiveGroups(limit: 1000"));
            assert!(query.contains("dimensions { datetimeHour }"));
            assert!(!query.contains("ingressBytes"));
        }
    }
    fixture.stop().await;
}

#[actix_web::test]
async fn analytics_distinguishes_zero_usage_from_invalid_or_partial_results() {
    let fixture = Fixture::new().await;
    let empty = json!({"data": {"viewer": {"accounts": [{"callsTurnUsageAdaptiveGroups": []}]}}, "errors": []});
    for body in [empty, usage_response(json!(0))] {
        fixture.reply(StatusCode::OK, body);
        assert_eq!(
            fixture
                .client
                .usage("account", "key", "token", "peer", 0, 60000)
                .await
                .unwrap()
                .egress_bytes,
            0
        );
    }
    let mut partial = usage_response(json!(123));
    partial["errors"] = json!([{"message": "private-provider-secret"}]);
    for body in [
        partial,
        json!({"data": null, "errors": [{"message": "private-provider-secret"}]}),
        json!({"data": {"viewer": {"accounts": []}}}),
        json!({"data": {"viewer": {"accounts": [{}]}}}),
        json!({"data": {"viewer": {"accounts": [{"callsTurnUsageAdaptiveGroups": null}]}}}),
        json!({"data": {"viewer": {"accounts": [{"callsTurnUsageAdaptiveGroups": [{"sum": {"egressBytes": 1}}, {"sum": {"egressBytes": 2}}]}]}}}),
        usage_response(json!(-1)),
        usage_response(json!("123")),
        usage_response(Value::Null),
        usage_response(json!(u64::MAX)),
        usage_response(json!(1.0e30)),
    ] {
        fixture.reply(StatusCode::OK, body);
        assert_provider_error(
            fixture
                .client
                .usage("account", "key", "token", "peer", 0, 60000)
                .await
                .unwrap_err(),
        );
    }
    fixture.reply(StatusCode::TOO_MANY_REQUESTS, usage_response(json!(999)));
    assert_provider_error(
        fixture
            .client
            .usage("account", "key", "token", "peer", 0, 60000)
            .await
            .unwrap_err(),
    );
    fixture.stop().await;
}

#[actix_web::test]
async fn analytics_rounds_sampled_fractional_totals_without_losing_exact_integers() {
    let fixture = Fixture::new().await;
    for (provider_bytes, expected) in [
        (json!(1234.6), 1235),
        (json!(0.4), 0),
        (json!(9_007_199_254_740_993_i64), 9_007_199_254_740_993),
    ] {
        fixture.reply(StatusCode::OK, usage_response(provider_bytes));
        assert_eq!(
            fixture
                .client
                .usage("account", "key", "token", "peer", 0, 60000)
                .await
                .unwrap()
                .egress_bytes,
            expected
        );
    }
    fixture.stop().await;
}

#[actix_web::test]
async fn daily_analytics_expand_billing_start_to_midnight_and_keep_billing_total() {
    let fixture = Fixture::new().await;
    let mut response = usage_response(json!(90));
    response["data"]["viewer"]["accounts"][0]["daily"] = json!([
        {"dimensions": {"datetimeHour": "1970-01-01T00:00:00Z"}, "sum": {"egressBytes": 40}},
        {"dimensions": {"datetimeHour": "1970-01-01T23:00:00Z"}, "sum": {"egressBytes": 70}},
        {"dimensions": {"datetimeHour": "1970-01-02T00:00:00Z"}, "sum": {"egressBytes": 20}},
    ]);
    fixture.reply(StatusCode::OK, response);
    let snapshot = fixture
        .client
        .usage(
            "account",
            "key",
            "token",
            "peer",
            12 * HOUR_MS,
            DAY_MS + HOUR_MS,
        )
        .await
        .unwrap();
    assert_eq!(snapshot.egress_bytes, 90);
    assert_eq!(
        snapshot.days.unwrap(),
        vec![
            CloudflareTurnDailyUsage {
                day_start: 0,
                egress_bytes: 110
            },
            CloudflareTurnDailyUsage {
                day_start: DAY_MS,
                egress_bytes: 20
            },
        ]
    );
    {
        let state = fixture.state.lock().unwrap();
        let query = state.requests[0].body["query"].as_str().unwrap();
        assert!(query.contains("datetime_geq: \"1970-01-01T12:00:00.000Z\""));
        assert!(query.contains("datetime_geq: \"1970-01-01T00:00:00.000Z\""));
    }
    // Missing timeseries preserves the independently valid billing aggregate.
    fixture.reply(StatusCode::OK, usage_response(json!(91)));
    let snapshot = fixture
        .client
        .usage("account", "key", "token", "peer", 0, DAY_MS)
        .await
        .unwrap();
    assert_eq!(snapshot.egress_bytes, 91);
    assert!(snapshot.days.is_none());
    fixture.stop().await;
}

#[actix_web::test]
async fn daily_only_graphql_errors_preserve_billing_but_discard_partial_daily_data() {
    let fixture = Fixture::new().await;
    for path in [
        json!(["viewer", "accounts", 0, "daily"]),
        json!(["viewer", "accounts", 0, "daily", 0, "sum", "egressBytes"]),
    ] {
        let mut response = usage_response(json!(123));
        // Even a parseable empty series is incomplete when its resolver errored.
        response["data"]["viewer"]["accounts"][0]["daily"] = json!([]);
        response["errors"] = json!([{ "message": "private-provider-secret", "path": path }]);
        fixture.reply(StatusCode::OK, response);
        let snapshot = fixture
            .client
            .usage("account", "key", "token", "peer", 0, DAY_MS)
            .await
            .unwrap();
        assert_eq!(snapshot.egress_bytes, 123);
        assert!(snapshot.days.is_none());
    }
    fixture.stop().await;
}

#[actix_web::test]
async fn graphql_errors_outside_daily_and_incomplete_billing_still_fail_closed() {
    let fixture = Fixture::new().await;
    let daily_error = json!({"path": ["viewer", "accounts", 0, "daily"]});
    for errors in [
        json!([{"message": "private-provider-secret"}]),
        json!([{"path": ["viewer", "accounts", 0]}]),
        json!([{"path": ["viewer", "accounts", 0, "callsTurnUsageAdaptiveGroups", 0, "sum", "egressBytes"]}]),
        json!([{"path": ["viewer", "accounts", 0, "unknown"]}]),
        json!([{"path": ["viewer", "accounts", 1, "daily"]}]),
        json!([daily_error, {"path": ["viewer"]}]),
        json!([{"path": ["viewer", "accounts", 0, "daily", null]}]),
        json!({"path": ["viewer", "accounts", 0, "daily"]}),
    ] {
        let mut response = usage_response(json!(123));
        response["errors"] = errors;
        fixture.reply(StatusCode::OK, response);
        assert_provider_error(
            fixture
                .client
                .usage("account", "key", "token", "peer", 0, DAY_MS)
                .await
                .unwrap_err(),
        );
    }
    let mut response = usage_response(Value::Null);
    response["errors"] = json!([daily_error]);
    fixture.reply(StatusCode::OK, response);
    assert_provider_error(
        fixture
            .client
            .usage("account", "key", "token", "peer", 0, DAY_MS)
            .await
            .unwrap_err(),
    );
    fixture.stop().await;
}

#[actix_web::test]
async fn daily_analytics_fill_empty_dates_and_reject_duplicate_or_out_of_window_hours() {
    let mut response = usage_response(json!(0));
    response["data"]["viewer"]["accounts"][0]["daily"] = json!([]);
    assert_eq!(
        daily_usage(&response, 0, DAY_MS * 2).unwrap(),
        vec![
            CloudflareTurnDailyUsage {
                day_start: 0,
                egress_bytes: 0
            },
            CloudflareTurnDailyUsage {
                day_start: DAY_MS,
                egress_bytes: 0
            },
        ]
    );
    let group =
        json!({"dimensions": {"datetimeHour": "1970-01-01T00:00:00Z"}, "sum": {"egressBytes": 5}});
    response["data"]["viewer"]["accounts"][0]["daily"] = json!([group, group]);
    assert!(daily_usage(&response, 0, DAY_MS).is_err());
    response["data"]["viewer"]["accounts"][0]["daily"] = json!([group]);
    assert!(daily_usage(&response, DAY_MS, DAY_MS * 2).is_err());
}
