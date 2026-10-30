//! GitHub identity creation and login must preserve account ownership and site policy.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{ConnectionTrait, Database, TransactionTrait};

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn github_identity_obeys_registration_policy_and_never_links_by_email() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("github_test_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{url}{separator}options=-csearch_path%3D{schema}");
    let store = ControlStore::connect(&scoped_url).await.unwrap();
    // Exercise an upgrade from an already applied GitHub identity migration.
    store.database().execute_unprepared("ALTER TABLE cp_users DROP COLUMN authentication_generation; DROP SEQUENCE cp_authentication_generation; DELETE FROM cp_migrations WHERE version=14").await.unwrap();
    store.close().await.unwrap();
    let store = ControlStore::connect(&scoped_url).await.unwrap();

    let existing = store
        .verified_user("existing@example.test", "Existing")
        .await
        .unwrap();
    assert!(matches!(
        store
            .github_user("other", "EXISTING@example.test", "Other", true)
            .await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(store.account(&existing.id).await.unwrap().name, "Existing");

    store
        .database()
        .execute_unprepared(
            "UPDATE cp_site_settings SET terms_of_service_url='https://example.test/terms'",
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .github_user("123", "new@example.test", "New", false)
            .await,
        Err(Error::Invalid(_))
    ));
    let created = store
        .github_user("123", "new@example.test", "New", true)
        .await
        .unwrap();
    store
        .database()
        .execute_unprepared("UPDATE cp_registration_policy SET enabled=FALSE")
        .await
        .unwrap();
    assert!(matches!(
        store
            .github_user("456", "another@example.test", "Another", true)
            .await,
        Err(Error::Invalid(_))
    ));
    let login = store
        .github_user("123", "changed@example.test", "Changed", false)
        .await
        .unwrap();
    assert_eq!(login.id, created.id);
    assert_eq!(login.email.as_deref(), Some("new@example.test"));
    assert_eq!(login.name, "New");

    // A start racing a credential revocation must wait for its transaction to
    // commit before receiving a newer generation.
    let before = store.authentication_generation().await.unwrap();
    let tx = store.database().begin().await.unwrap();
    tx.execute_unprepared("SELECT pg_advisory_xact_lock(761946023)")
        .await
        .unwrap();
    tx.execute_unprepared(&format!("UPDATE cp_users SET authentication_generation=nextval('cp_authentication_generation') WHERE id='{}'", created.id)).await.unwrap();
    let concurrent_store = store.clone();
    let mut start =
        tokio::spawn(async move { concurrent_store.authentication_generation().await.unwrap() });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut start)
            .await
            .is_err()
    );
    tx.commit().await.unwrap();
    let after = start.await.unwrap();
    assert!(matches!(
        store.new_session_at_generation(&created.id, before).await,
        Err(Error::Unauthorized)
    ));
    assert!(
        store
            .new_session_at_generation(&created.id, after)
            .await
            .is_ok()
    );

    store
        .database()
        .execute_unprepared(&format!(
            "UPDATE cp_users SET disabled=TRUE WHERE id='{}'",
            created.id
        ))
        .await
        .unwrap();
    assert!(matches!(
        store
            .github_user("123", "new-address@example.test", "New", true)
            .await,
        Err(Error::Unauthorized)
    ));

    store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
