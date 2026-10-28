use super::{BillingService, BillingWorker};
use deskfleet_control_store::ControlStore;
use std::time::Duration;
use tokio::time::{MissedTickBehavior, interval};

impl BillingService {
    pub fn start_worker(&self, store: ControlStore) -> BillingWorker {
        let inbox_service = self.clone();
        let inbox_store = store.clone();
        let repair_service = self.clone();
        let analytics_service = self.clone();
        let analytics_store = store.clone();
        BillingWorker([
            tokio::spawn(async move { inbox_service.run_inbox(inbox_store).await }),
            tokio::spawn(async move { repair_service.run_repairs(store).await }),
            tokio::spawn(async move { analytics_service.run_analytics(analytics_store).await }),
        ])
    }

    async fn run_inbox(&self, store: ControlStore) {
        if !self.enabled() {
            return;
        }
        let mut tick = interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            for _ in 0..25 {
                match store.claim_payment_event().await {
                    Ok(Some(event)) => {
                        let success = self.process_event(&store, &event).await.is_ok();
                        if !success {
                            tracing::warn!(event_id=%event.id,"payment reconciliation failed; scheduled retry");
                        }
                        if store.finish_payment_event(&event, success).await.is_err() {
                            tracing::warn!("payment event result could not be persisted");
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        tracing::warn!("payment event inbox is unavailable");
                        break;
                    }
                }
            }
        }
    }

    async fn run_repairs(&self, store: ControlStore) {
        if !self.enabled() {
            return;
        }
        let mut tick = interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            for _ in 0..25 {
                match store.claim_billing_reconciliation().await {
                    Ok(Some((team, lease))) => {
                        if self.reconcile_claimed(&store, &team, &lease).await.is_err() {
                            tracing::warn!(team_id=%team,"subscription repair will retry");
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        tracing::warn!("subscription repair queue is unavailable");
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing::BillingConfig;
    use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use serde_json::json;
    use std::{collections::HashMap, net::TcpListener};
    use tokio::sync::Notify;

    #[derive(Default)]
    struct Provider {
        repair_started: Notify,
        repair_for_inbox: Notify,
        repair_release: Notify,
    }

    async fn provider(req: HttpRequest, state: web::Data<Provider>) -> HttpResponse {
        if req.path() == "/v1/invoices/invoice_fast" {
            // The inbox's first tick can claim this event immediately, but its
            // provider response waits until periodic repair is demonstrably blocked.
            state.repair_for_inbox.notified().await;
            return HttpResponse::Ok().json(json!({"customer":"cus_fast"}));
        }
        assert_eq!(req.path(), "/v1/subscriptions");
        let query: HashMap<String, String> =
            url::form_urlencoded::parse(req.query_string().as_bytes())
                .into_owned()
                .collect();
        if query["customer"] == "cus_slow" {
            state.repair_started.notify_one();
            state.repair_for_inbox.notify_one();
            state.repair_release.notified().await;
        }
        HttpResponse::Ok().json(json!({"data":[],"has_more":false}))
    }

    #[actix_web::test]
    #[ignore = "requires PostgreSQL TEST_DATABASE_URL; provider is local HTTP"]
    async fn payment_inbox_progresses_while_periodic_repair_waits_on_provider() {
        let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let db = Database::connect(&url).await.unwrap();
        let schema = format!("billing_worker_{}", uuid::Uuid::new_v4().simple());
        db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let owner = store
            .verified_user("worker@billing.test", "Owner")
            .await
            .unwrap();
        for customer in ["cus_slow", "cus_fast"] {
            let team = store.create_team(&owner.id, customer).await.unwrap();
            let lease = store
                .claim_billing_operation(&team.id)
                .await
                .unwrap()
                .unwrap();
            store
                .billing_customer(&team.id, &lease, customer)
                .await
                .unwrap();
            store
                .release_billing_operation(&team.id, &lease)
                .await
                .unwrap();
        }
        store.database().execute_unprepared("UPDATE cp_billing_profiles SET reconcile_after=9223372036854775807 WHERE customer_id='cus_fast'").await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let provider_state = web::Data::new(Provider::default());
        let server_state = provider_state.clone();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(server_state.clone())
                .default_service(web::route().to(provider))
        })
        .workers(1)
        .listen(listener)
        .unwrap()
        .run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        let mut service = BillingService::new(
            BillingConfig {
                hosted: true,
                stripe_secret_key: Some("sk_test_fixture".into()),
                stripe_webhook_secret: Some("whsec_fixture".into()),
                go_price_id: Some("price_go".into()),
                pro_price_id: Some("price_pro".into()),
                go_yearly_price_id: Some("price_go_year".into()),
                pro_yearly_price_id: Some("price_pro_year".into()),
                portal_configuration_id: Some("bpc_month".into()),
                yearly_portal_configuration_id: Some("bpc_year".into()),
                enterprise_contact_email: None,
                statsig_server_key: None,
                statsig_environment: None,
            },
            "https://web.test".into(),
        )
        .unwrap();
        service.api_base = format!("http://{address}/v1");
        store
            .receive_payment_event("event_fast", "invoice.paid", "invoice_fast", None, None)
            .await
            .unwrap();
        let worker = service.start_worker(store.clone());
        tokio::time::timeout(
            Duration::from_secs(5),
            provider_state.repair_started.notified(),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            let mut tick = interval(Duration::from_millis(25));
            loop {
                tick.tick().await;
                let row = store
                    .database()
                    .query_one_raw(Statement::from_string(
                        DbBackend::Postgres,
                        "SELECT status FROM cp_payment_events WHERE id='event_fast'",
                    ))
                    .await
                    .unwrap()
                    .unwrap();
                if row.try_get::<String>("", "status").unwrap() == "processed" {
                    break;
                }
            }
        })
        .await
        .expect("the payment inbox must not wait for periodic repair");
        provider_state.repair_release.notify_one();
        drop(worker);
        handle.stop(true).await;
        task.await.unwrap().unwrap();
        store.close().await.unwrap();
        db.execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
            .await
            .unwrap();
        db.close().await.unwrap();
    }
}
