//! Explicit development seeds are atomic and never modify an existing account.
use deskfleet_control_store::ControlStore;
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use serde_json::{Value, json};

async fn account(store: &ControlStore, email: &str) -> Value {
    store
        .database()
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT to_jsonb(u) AS record FROM cp_users u WHERE email=$1",
            [email.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "record")
        .unwrap()
}

async fn audit(store: &ControlStore) -> Vec<Value> {
    store
        .database()
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT to_jsonb(a) AS record FROM cp_site_audit a ORDER BY id",
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "record").unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn development_seed_is_atomic_insert_only_and_safe_under_concurrency() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("development_seed_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped_url =
        format!("{url}{separator}options=-csearch_path%3D{schema}&application_name={schema}");
    let store = ControlStore::connect(&scoped_url).await.unwrap();

    assert!(
        store
            .seed_development_admin(
                " Admin@deskfleet.test ",
                "Development Admin",
                "initial hash"
            )
            .await
            .unwrap()
    );
    let created = account(&store, "admin@deskfleet.test").await;
    let user_id = created["id"].as_str().unwrap();
    assert_eq!(created["name"], "Development Admin");
    assert_eq!(created["email_verified"], true);
    assert_eq!(created["disabled"], false);
    assert_eq!(created["credential_version"], 0);
    let credentials = store
        .password_credentials("ADMIN@deskfleet.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(credentials["passwordHash"], "initial hash");
    assert!(store.new_session(user_id).await.is_ok());
    assert!(store.is_site_admin(user_id).await.unwrap());
    let grants = store.site_admins().await.unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0]["source"], "cli");
    let initial_audit = audit(&store).await;
    assert_eq!(initial_audit.len(), 1);
    assert_eq!(initial_audit[0]["source"], "cli");
    assert_eq!(initial_audit[0]["action"], "admin.grant");
    assert_eq!(initial_audit[0]["actor_user_id"], Value::Null);
    assert_eq!(initial_audit[0]["target_user_id"], user_id);
    assert_eq!(initial_audit[0]["before_value"], json!({"siteAdmin":false}));
    assert_eq!(initial_audit[0]["after_value"], json!({"siteAdmin":true}));
    assert!(store.teams(user_id).await.unwrap().is_empty());

    assert!(
        !store
            .seed_development_admin("admin@deskfleet.test", "Replacement", "replacement hash")
            .await
            .unwrap()
    );
    assert_eq!(account(&store, "admin@deskfleet.test").await, created);
    assert_eq!(audit(&store).await, initial_audit);
    assert_eq!(store.site_admins().await.unwrap(), grants);

    // A subsequent operator revocation or account edit must remain authoritative.
    assert!(store.revoke_site_admin(user_id).await.unwrap());
    store.database().execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE cp_users SET name='Changed name',password_hash='changed hash',disabled=TRUE,email_verified=FALSE,credential_version=7 WHERE id=$1",
        [user_id.into()],
    )).await.unwrap();
    let changed = account(&store, "admin@deskfleet.test").await;
    let changed_audit = audit(&store).await;
    assert!(
        !store
            .seed_development_admin("admin@deskfleet.test", "Reset name", "reset hash")
            .await
            .unwrap()
    );
    assert_eq!(account(&store, "admin@deskfleet.test").await, changed);
    assert!(!store.is_site_admin(user_id).await.unwrap());
    assert_eq!(audit(&store).await, changed_audit);

    let (first, second) = tokio::join!(
        store.seed_development_admin("race@deskfleet.test", "First", "first hash"),
        store.seed_development_admin("RACE@deskfleet.test", "Second", "second hash"),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_ne!(
        first, second,
        "exactly one concurrent seed creates the account"
    );
    let raced = account(&store, "race@deskfleet.test").await;
    assert_eq!(raced["name"], if first { "First" } else { "Second" });
    assert_eq!(
        raced["password_hash"],
        if first { "first hash" } else { "second hash" }
    );
    let race_id = raced["id"].as_str().unwrap();
    assert!(store.is_site_admin(race_id).await.unwrap());
    let entries = audit(&store).await;
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry["target_user_id"] == race_id)
            .count(),
        1
    );

    // An unavailable audit must roll back the newly inserted identity and grant.
    store.database().execute_unprepared(
        "CREATE FUNCTION reject_seed_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
         CREATE TRIGGER reject_seed_audit BEFORE INSERT ON cp_site_audit FOR EACH ROW EXECUTE FUNCTION reject_seed_audit()",
    ).await.unwrap();
    assert!(
        store
            .seed_development_admin("rollback@deskfleet.test", "Rollback", "unused hash")
            .await
            .is_err()
    );
    assert!(
        store
            .password_credentials("rollback@deskfleet.test")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.site_admins().await.unwrap().len(), 1);
    assert_eq!(audit(&store).await, entries);

    store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
