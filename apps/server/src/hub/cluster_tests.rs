//! Congestion must not be interpreted as loss of PostgreSQL lease ownership.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::oneshot;

#[tokio::test]
async fn a_slow_delivery_survives_repeated_lease_renewals_without_restart() {
    let starts = Arc::new(AtomicUsize::new(0));
    let renewals = Arc::new(AtomicUsize::new(0));
    let (release, released) = oneshot::channel();
    let mut release = Some(release);
    let work = async {
        starts.fetch_add(1, Ordering::SeqCst);
        released.await.unwrap();
        Ok(())
    };
    tokio::time::timeout(
        Duration::from_secs(2),
        with_heartbeat(work, Duration::from_millis(5), || {
            if renewals.fetch_add(1, Ordering::SeqCst) == 2 {
                release.take().unwrap().send(()).unwrap();
            }
            std::future::ready(Ok(()))
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(renewals.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn an_in_flight_renewal_does_not_pause_delivery() {
    let (started, started_rx) = oneshot::channel();
    let mut started = Some(started);
    let work = async {
        started_rx.await.unwrap();
        Ok(())
    };
    tokio::time::timeout(
        Duration::from_secs(2),
        with_heartbeat(work, Duration::from_millis(5), || {
            started.take().unwrap().send(()).unwrap();
            std::future::pending()
        }),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn failed_renewal_cancels_delivery_before_recovery() {
    struct PendingDelivery(Arc<AtomicBool>);
    impl Drop for PendingDelivery {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let work = async {
        let _in_flight = PendingDelivery(cancelled.clone());
        std::future::pending().await
    };
    let error = with_heartbeat(work, Duration::from_millis(5), || {
        std::future::ready(Err(ApiError::unavailable()))
    })
    .await
    .unwrap_err();
    assert_eq!(error.code, "machine_offline");
    assert!(cancelled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn an_expired_request_is_not_queued_when_its_gate_and_timer_are_both_ready() {
    let hub = Hub::default();
    let (sender, mut messages) = super::super::mpsc::channel(8);
    let (shutdown, stopped) = watch::channel(None);
    hub.add_daemon("machine", "team", "machine", "socket", sender, shutdown)
        .await
        .unwrap();
    let gate = hub.registration.lock().await;
    let delivery = hub.dispatch(Envelope::Request {
        source: "source".into(),
        registration_id: "machine".into(),
        connection_id: "socket".into(),
        expires_at: deskfleet_control_store::now_ms() + 25,
        message: ControlMessage::Request {
            id: "expiring-request".into(),
            method: "catalogList".into(),
            params: serde_json::json!({}),
            actor: None,
        },
    });
    tokio::pin!(delivery);
    assert!(futures_util::poll!(&mut delivery).is_pending());
    // Deliberately do not poll the request until both the gate and deadline
    // are ready: timeout polls its inner future before inspecting its timer.
    std::thread::sleep(Duration::from_millis(50));
    drop(gate);
    // This local-only fixture cannot publish the expiry reply. The PostgreSQL
    // test below verifies its daemon_timeout result reaches the source node.
    assert!(delivery.await.is_err());
    assert!(hub.inner.lock().await.forwarded.is_empty());
    assert!(messages.try_recv().is_err());
    assert!(hub.online("machine").await);
    assert!(stopped.borrow().is_none());
}

struct Fixture {
    admin: sea_orm::DatabaseConnection,
    schema: String,
    store: ControlStore,
    hub: Hub,
    router: Router,
    stopped: watch::Receiver<Option<u16>>,
    messages: super::super::outbox::Receiver,
}

impl Fixture {
    async fn new() -> Self {
        use sea_orm::ConnectionTrait;
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let admin = sea_orm::Database::connect(&url).await.unwrap();
        let schema = format!("router_congestion_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let (hub, router) = connect(store.clone()).await.unwrap();
        let (sender, messages) = super::super::outbox::channel(8);
        let (shutdown, stopped) = watch::channel(None);
        hub.add_client("login", "user", "socket", sender, shutdown)
            .await
            .unwrap();
        Self {
            admin,
            schema,
            store,
            hub,
            router,
            stopped,
            messages,
        }
    }

    fn node(&self) -> &str {
        &self.hub.cluster.as_ref().unwrap().id
    }

    async fn publish(&self, envelope: &Envelope) {
        assert!(
            self.store
                .publish_node(self.node(), &serde_json::to_value(envelope).unwrap())
                .await
                .unwrap()
        );
    }

    async fn lease_millis(&self) -> i64 {
        use sea_orm::{ConnectionTrait, DbBackend, Statement};
        self.store
            .database()
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT (EXTRACT(EPOCH FROM lease_until)*1000)::bigint AS lease FROM cp_realtime_nodes WHERE id=$1",
                [self.node().into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "lease")
            .unwrap()
    }

    async fn close(self) {
        use sea_orm::ConnectionTrait;
        drop(self.router);
        self.store.close().await.unwrap();
        self.admin
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.admin.close().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_blocked_delivery_does_not_expire_the_node_or_close_its_sockets() {
    let mut f = Fixture::new().await;
    let initial_lease = f.lease_millis().await;
    let hub = f.hub.clone();
    let gate = hub.registration.lock().await;
    f.publish(&Envelope::Request {
        source: f.node().into(),
        registration_id: "0".into(),
        connection_id: "blocked".into(),
        expires_at: deskfleet_control_store::now_ms() + 60_000,
        message: ControlMessage::Request {
            id: "blocked-request".into(),
            method: "catalogList".into(),
            params: serde_json::json!({}),
            actor: None,
        },
    })
    .await;
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            assert!(f.hub.cluster.as_ref().unwrap().ready());
            assert!(f.stopped.borrow().is_none());
            if f.lease_millis().await > initial_lease {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("lease renewal runs while request delivery waits for the gate");
    drop(gate);

    // A later explicit disconnect still reaches the same healthy socket.
    f.publish(&Envelope::Disconnect {
        audience: Audience::Login("login".into()),
    })
    .await;
    assert_eq!(
        *tokio::time::timeout(Duration::from_secs(2), f.stopped.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap(),
        Some(4401)
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_request_expiry_cancels_gated_enqueue_without_taking_machine_offline() {
    let mut f = Fixture::new().await;
    let user = f
        .store
        .verified_user("expiry@fixture.test", "Owner")
        .await
        .unwrap();
    let team = f.store.create_team(&user.id, "Expiry").await.unwrap();
    let (machine, _) = f
        .store
        .enroll(
            &user.id,
            &team.id,
            "Machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            serde_json::json!({}),
            &deskfleet_control_store::secret(),
        )
        .await
        .unwrap();
    let (sender, mut messages) = super::super::mpsc::channel(8);
    let (shutdown, stopped) = watch::channel(None);
    f.hub
        .add_daemon(
            &machine.id,
            &machine.team_id,
            &machine.machine_id,
            "socket",
            sender,
            shutdown,
        )
        .await
        .unwrap();
    let source = uuid::Uuid::new_v4().to_string();
    f.store.register_node(&source).await.unwrap();
    let hub = f.hub.clone();
    let gate = hub.registration.lock().await;
    f.publish(&Envelope::Request {
        source: source.clone(),
        registration_id: machine.id.clone(),
        connection_id: "socket".into(),
        expires_at: deskfleet_control_store::now_ms() + 1_000,
        message: ControlMessage::Request {
            id: "expiring-request".into(),
            method: "catalogList".into(),
            params: serde_json::json!({}),
            actor: None,
        },
    })
    .await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while !f
            .hub
            .inner
            .lock()
            .await
            .forwarded
            .contains_key("expiring-request")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("request starts delivery while its registration gate is held");
    let responses = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let responses = f.store.take_node_messages(&source, 8).await.unwrap();
            if !responses.is_empty() {
                break responses;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("request returns timeout before the registration gate is released");
    assert_eq!(responses.len(), 1);
    let Envelope::Response { id, result, .. } =
        serde_json::from_value(responses.into_iter().next().unwrap()).unwrap()
    else {
        panic!("expected timeout response");
    };
    assert_eq!(id, "expiring-request");
    assert_eq!(result.into_result().unwrap_err().code, "daemon_timeout");
    assert!(f.hub.inner.lock().await.forwarded.is_empty());
    assert!(f.hub.online(&machine.id).await);
    assert!(stopped.borrow().is_none());
    assert!(messages.try_recv().is_err());
    drop(gate);

    // Processing the following envelope proves the consumed request is not
    // left behind the gate to execute or replay after its caller timed out.
    f.publish(&Envelope::Disconnect {
        audience: Audience::Login("login".into()),
    })
    .await;
    assert_eq!(
        *tokio::time::timeout(Duration::from_secs(2), f.stopped.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap(),
        Some(4401)
    );
    assert!(messages.try_recv().is_err());
    assert!(f.hub.online(&machine.id).await);
    assert!(stopped.borrow().is_none());
    assert!(
        f.store
            .take_node_messages(&source, 8)
            .await
            .unwrap()
            .is_empty()
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_bad_envelope_isolated_without_losing_the_following_disconnect() {
    let mut f = Fixture::new().await;
    f.store
        .publish_node(f.node(), &serde_json::json!({"invalid": "envelope"}))
        .await
        .unwrap();
    f.publish(&Envelope::Disconnect {
        audience: Audience::Login("login".into()),
    })
    .await;
    assert_eq!(
        *tokio::time::timeout(Duration::from_secs(2), f.stopped.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap(),
        Some(4401)
    );
    assert!(f.hub.cluster.as_ref().unwrap().ready());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_database_failure_still_fences_existing_sockets() {
    let mut f = Fixture::new().await;
    f.store.clone().close().await.unwrap();
    assert_eq!(
        *tokio::time::timeout(Duration::from_secs(2), f.stopped.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap(),
        Some(1012)
    );
    assert!(!f.hub.cluster.as_ref().unwrap().ready());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_expired_lease_fences_before_waiting_for_the_registration_gate() {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let mut f = Fixture::new().await;
    let hub = f.hub.clone();
    let gate = hub.registration.lock().await;
    f.store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_realtime_nodes SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [f.node().into()],
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        while f.hub.cluster.as_ref().unwrap().ready() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("expired ownership is fenced even while socket cleanup waits");
    assert!(f.hub.cluster.as_ref().unwrap().ensure_ready().is_err());
    drop(gate);
    assert_eq!(
        *tokio::time::timeout(Duration::from_secs(2), f.stopped.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap(),
        Some(1012)
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_critical_delivery_recovers_after_the_old_timeout_without_reconnecting() {
    let mut f = Fixture::new().await;
    let sender = f.hub.inner.lock().await.clients["login"]["socket"]
        .sender
        .clone();
    for _ in 0..8 {
        sender.try_send(ControlMessage::Ping).unwrap();
    }
    f.publish(&Envelope::Notify {
        audience: Audience::Login("login".into()),
        message: ControlMessage::PeerRevoked {
            peer_id: "revoked-peer".into(),
            reason: "revoked".into(),
        },
    })
    .await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert!(f.stopped.borrow().is_none());
    assert!(f.hub.cluster.as_ref().unwrap().ready());
    for _ in 0..8 {
        assert!(matches!(
            f.messages.recv().await,
            Some(super::super::outbox::Outbound::Message(message))
                if matches!(*message, ControlMessage::Ping)
        ));
    }
    let recovered = tokio::time::timeout(Duration::from_secs(2), f.messages.recv())
        .await
        .expect("critical delivery resumes on the existing client socket");
    assert!(matches!(
        recovered,
        Some(super::super::outbox::Outbound::Message(message))
            if matches!(*message, ControlMessage::PeerRevoked { ref peer_id, .. }
                if peer_id == "revoked-peer")
    ));
    assert!(f.stopped.borrow().is_none());
    assert!(f.hub.cluster.as_ref().unwrap().ready());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_stalled_critical_delivery_closes_its_client_without_fencing_the_node() {
    let mut f = Fixture::new().await;
    let (healthy_sender, mut healthy_messages) = super::super::mpsc::channel(8);
    let (healthy_shutdown, healthy_stopped) = watch::channel(None);
    f.hub
        .add_client(
            "healthy",
            "user",
            "healthy-socket",
            healthy_sender,
            healthy_shutdown,
        )
        .await
        .unwrap();
    let sender = f.hub.inner.lock().await.clients["login"]["socket"]
        .sender
        .clone();
    for _ in 0..8 {
        sender.try_send(ControlMessage::Ping).unwrap();
    }
    f.publish(&Envelope::Notify {
        audience: Audience::Users(vec!["user".into()]),
        message: ControlMessage::PeerRevoked {
            peer_id: "revoked-peer".into(),
            reason: "revoked".into(),
        },
    })
    .await;
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), healthy_messages.recv())
            .await
            .unwrap(),
        Some(ControlMessage::PeerRevoked { .. })
    ));
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert!(f.stopped.borrow().is_none());
    assert_eq!(
        *tokio::time::timeout(Duration::from_secs(30), f.stopped.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap(),
        Some(1012)
    );
    assert!(healthy_stopped.borrow().is_none());
    assert!(f.hub.cluster.as_ref().unwrap().ready());
    f.close().await;
}
