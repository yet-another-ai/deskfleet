//! Checkout writes must retain their billing lease until commit.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement, TransactionTrait};
use std::time::Duration;

fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn checkout_writes_recheck_concurrently_replaced_billing_leases() {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("checkout_concurrency_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let actor = store
        .verified_user("owner@checkout.test", "Owner")
        .await
        .unwrap();

    for operation in ["create", "update", "complete"] {
        let team = store.create_team(&actor.id, operation).await.unwrap();
        let token = store
            .claim_billing_operation(&team.id)
            .await
            .unwrap()
            .unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        if operation != "create" {
            store
                .create_checkout_attempt(&team.id, &token, &request, "go", "month", &actor.id)
                .await
                .unwrap();
        }

        // A replacement claim is in flight. MVCC readers can still see the old
        // token; the checkout writer must wait for the profile row and recheck.
        let replacing = store.database().begin().await.unwrap();
        replacing
            .execute_raw(sql(
                "UPDATE cp_billing_profiles SET lease_token='replacement' WHERE team_id=$1",
                vec![team.id.parse::<i64>().unwrap().into()],
            ))
            .await
            .unwrap();
        let pid: i32 = replacing
            .query_one_raw(sql("SELECT pg_backend_pid() AS pid", vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "pid")
            .unwrap();
        let worker_store = store.clone();
        let worker_team = team.id.clone();
        let worker_request = request.clone();
        let worker_actor = actor.id.clone();
        let mut writer = tokio::spawn(async move {
            match operation {
                "create" => worker_store
                    .create_checkout_attempt(
                        &worker_team,
                        &token,
                        &worker_request,
                        "go",
                        "month",
                        &worker_actor,
                    )
                    .await
                    .map(|_| ()),
                "update" => {
                    worker_store
                        .update_checkout_attempt(
                            &worker_team,
                            &token,
                            &worker_request,
                            "cs_stale",
                            "open",
                            &[],
                        )
                        .await
                }
                "complete" => {
                    worker_store
                        .complete_checkout_request(&worker_team, &token, &worker_request)
                        .await
                }
                _ => unreachable!(),
            }
        });
        let early_result = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                result = &mut writer => Some(result.unwrap()),
                () = async {
                    loop {
                        let blocked: bool = admin.query_one_raw(sql(
                            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",
                            vec![pid.into()],
                        )).await.unwrap().unwrap().try_get("", "blocked").unwrap();
                        if blocked { break; }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                } => None,
            }
        }).await.expect("checkout write must complete or wait for the lease lock");
        replacing.commit().await.unwrap();
        let result = match early_result {
            Some(result) => result,
            None => writer.await.unwrap(),
        };
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "{operation}: {result:?}"
        );
        let attempt = store.checkout_attempt(&request).await.unwrap();
        if operation == "create" {
            assert!(attempt.is_none());
        } else {
            let attempt = attempt.unwrap();
            assert_eq!(attempt.status, "pending");
            assert!(attempt.session_id.is_none());
        }
    }
    store.close().await.unwrap();
    admin
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    admin.close().await.unwrap();
}
