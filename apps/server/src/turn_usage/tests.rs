use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use actix_web::{App, http::StatusCode, test, web};
use deskfleet_control_store::{AuthSession, ControlStore, now_ms, timestamp};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget};
use redis::aio::MultiplexedConnection;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::json;
use tokio::time::{sleep, timeout};

use super::Collector;
use crate::{AppState, config::ServerConfig, configure};

const WAIT: Duration = Duration::from_secs(5);
// These collector lifecycle tests manipulate the same database singleton.
static COLLECTOR_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn reset_collector(store: &ControlStore) {
    store.database().execute_unprepared(
        "UPDATE cp_turn_collector SET owner=NULL,lease_until=NULL,last_seen_at=NULL,gap_since=NULL WHERE singleton",
    ).await.unwrap();
}

async fn peer(store: &ControlStore, auth: &AuthSession) -> PeerAuthorization {
    let team = store
        .create_team(&auth.user.id, "TURN subscriber fixture")
        .await
        .unwrap();
    let (machine, _) = store
        .enroll(
            &auth.user.id,
            &team.id,
            "TURN subscriber fixture",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let expires = now_ms() + 60_000;
    let grant = PeerAuthorization {
        peer_id: uuid::Uuid::new_v4().to_string(),
        server_id: "https://control.test".into(),
        team_id: team.id,
        actor: PeerActor {
            kind: "user".into(),
            user_id: auth.user.id.clone(),
            device_id: auth.device_id.clone(),
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: machine.id,
            origin_id: machine.origin_id,
            local_machine_id: "1".into(),
        },
        purpose: "agent".into(),
        actions: vec!["agent:read".into()],
        issued_at: timestamp(now_ms()),
        expires_at: timestamp(expires),
    };
    store.save_peer(&grant, &auth.id, expires).await.unwrap();
    grant
}

async fn subscribers(connection: &mut MultiplexedConnection) -> Vec<(u64, usize)> {
    let clients: String = redis::cmd("CLIENT")
        .arg("LIST")
        .arg("TYPE")
        .arg("PUBSUB")
        .query_async(connection)
        .await
        .unwrap();
    clients
        .lines()
        .map(|line| {
            let field = |name| {
                line.split_whitespace()
                    .find_map(|part| part.strip_prefix(name))
                    .unwrap()
            };
            (
                field("id=").parse().unwrap(),
                field("psub=").parse().unwrap(),
            )
        })
        .collect()
}

async fn wait_subscription(connection: &mut MultiplexedConnection, excluded: &[u64]) -> u64 {
    timeout(WAIT, async {
        loop {
            if let Some((id, _)) = subscribers(connection)
                .await
                .into_iter()
                .find(|(id, patterns)| !excluded.contains(id) && *patterns == 4)
            {
                return id;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("collector did not subscribe to all four traffic patterns")
}

async fn publish(connection: &mut MultiplexedConnection, channel: &str, received: i64, sent: i64) {
    let _: usize = redis::cmd("PUBLISH")
        .arg(channel)
        .arg(format!("rcvp=1, rcvb={received}, sentp=1, sentb={sent}"))
        .query_async(connection)
        .await
        .unwrap();
}

async fn totals(store: &ControlStore, team: &str, side: &str) -> (i64, i64, i64) {
    let row = store
        .database()
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT COUNT(*) AS events, COALESCE(SUM(received_bytes),0)::bigint AS received, COALESCE(SUM(sent_bytes),0)::bigint AS sent FROM cp_turn_usage WHERE team_id=$1 AND side=$2",
            vec![team.parse::<i64>().unwrap().into(), side.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    (
        row.try_get("", "events").unwrap(),
        row.try_get("", "received").unwrap(),
        row.try_get("", "sent").unwrap(),
    )
}

async fn wait_totals(store: &ControlStore, team: &str, side: &str, expected: (i64, i64, i64)) {
    timeout(WAIT, async {
        loop {
            let actual = totals(store, team, side).await;
            assert!(
                actual.0 <= expected.0,
                "unexpected duplicate usage: {actual:?}"
            );
            if actual.0 == expected.0 {
                assert_eq!(actual, expected);
                return;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("collector did not persist expected Team usage");
}

#[tokio::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL and Redis TEST_REDIS_URL"]
async fn redis_usage_reaches_teams_and_collection_resumes_after_disconnect() {
    let _collector_guard = COLLECTOR_TEST_LOCK.lock().await;
    let store =
        ControlStore::connect(&std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"))
            .await
            .unwrap();
    reset_collector(&store).await;
    let redis_url = std::env::var("TEST_REDIS_URL").expect("set TEST_REDIS_URL");
    let client = redis::Client::open(redis_url.as_str()).unwrap();
    let mut connection = client.get_multiplexed_async_connection().await.unwrap();
    let mut excluded: Vec<_> = subscribers(&mut connection)
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let user = store
        .verified_user(
            &format!("owner-{}@fixture.test", uuid::Uuid::new_v4()),
            "Owner",
        )
        .await
        .unwrap();
    let login = store.new_session(&user.id).await.unwrap();
    let auth = store
        .authenticate(login["token"].as_str().unwrap())
        .await
        .unwrap();
    let first = peer(&store, &auth).await;
    let second = peer(&store, &auth).await;
    let first_channel = format!(
        "turn/realm/turn.test/user/{}:{}/allocation/000000000000000001/traffic",
        now_ms() / 1000 + 60,
        first.peer_id,
    );
    let second_channel = format!(
        "turn/user/{}:{}/allocation/000000000000000002/traffic",
        now_ms() / 1000 + 60,
        second.peer_id,
    );

    let collector = Collector::start(store.clone(), &redis_url).unwrap();
    let collector_id = wait_subscription(&mut connection, &excluded).await;
    timeout(WAIT, async {
        while store.billing_summary(&first.team_id).await.unwrap()["metering"]["fresh"] != true {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("subscribed Redis heartbeat did not mark metering fresh");
    // Publishing the final totals before deltas makes the later count checks
    // detect accidental double counting without waiting an arbitrary grace period.
    for channel in [&first_channel, &second_channel] {
        let total = channel.replace("/traffic", "/total_traffic");
        publish(&mut connection, &total, 10_000, 20_000).await;
        publish(&mut connection, &format!("{total}/peer"), 10_000, 20_000).await;
    }
    publish(&mut connection, &first_channel, 10, 20).await;
    publish(&mut connection, &first_channel, 10, 20).await;
    publish(&mut connection, &format!("{first_channel}/peer"), 30, 40).await;
    publish(&mut connection, &second_channel, 50, 60).await;
    publish(&mut connection, &format!("{second_channel}/peer"), 70, 80).await;
    wait_totals(&store, &first.team_id, "client", (2, 20, 40)).await;
    wait_totals(&store, &first.team_id, "peer", (1, 30, 40)).await;
    wait_totals(&store, &second.team_id, "client", (1, 50, 60)).await;
    wait_totals(&store, &second.team_id, "peer", (1, 70, 80)).await;

    let killed: usize = redis::cmd("CLIENT")
        .arg("KILL")
        .arg("ID")
        .arg(collector_id)
        .query_async(&mut connection)
        .await
        .unwrap();
    assert_eq!(killed, 1);
    excluded.push(collector_id);
    let replacement_id = wait_subscription(&mut connection, &excluded).await;
    assert_ne!(replacement_id, collector_id);
    publish(&mut connection, &first_channel, 7, 8).await;
    wait_totals(&store, &first.team_id, "client", (3, 27, 48)).await;

    drop(collector);
    store.close().await.unwrap();
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn unavailable_redis_does_not_block_server_startup_or_health() {
    let _collector_guard = COLLECTOR_TEST_LOCK.lock().await;
    // Each attempted Redis handshake fails, allowing repeated reconnect attempts.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redis_url = format!("redis://{}/", listener.local_addr().unwrap());
    let attempts = Arc::new(AtomicUsize::new(0));
    let observed = attempts.clone();
    let rejecting = tokio::spawn(async move {
        while let Ok((connection, _)) = listener.accept().await {
            observed.fetch_add(1, Ordering::Relaxed);
            drop(connection);
        }
    });
    let config = ServerConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
        public_url: "https://control.test".into(),
        web_origins: vec![],
        auth: crate::auth::config::AuthConfig::development("https://control.test"),
        billing: Default::default(),
        stun_urls: vec![],
        turn_urls: vec![],
        turn_secret: None,
        turn_usage_redis_url: Some(redis_url),
    };
    let setup = ControlStore::connect(&config.database_url).await.unwrap();
    reset_collector(&setup).await;
    setup.close().await.unwrap();
    let state = web::Data::new(
        timeout(WAIT, AppState::new(config))
            .await
            .expect("Redis availability must not gate server startup")
            .unwrap(),
    );
    let store = state.store.clone();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    let response =
        test::call_service(&app, test::TestRequest::get().uri("/healthz").to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    timeout(WAIT, async {
        while attempts.load(Ordering::Relaxed) < 3 {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("collector did not retry failed Redis connections");
    let last_seen: Option<i64> = store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT last_seen_at FROM cp_turn_collector WHERE singleton",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "last_seen_at")
        .unwrap();
    assert_eq!(
        last_seen, None,
        "failed Redis attempts must not report fresh metering"
    );
    rejecting.abort();
    drop(app);
    drop(state);
    store.close().await.unwrap();
}
