//! Google subjects preserve account ownership, registration policy, and session revocation.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{ConnectionTrait, Database};

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn google_identity_preserves_policy_and_provider_boundaries() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("google_test_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{url}{separator}options=-csearch_path%3D{schema}");
    let store = ControlStore::connect(&scoped_url).await.unwrap();
    let github = store
        .github_user("same-subject", "github@example.test", "GitHub User", false)
        .await
        .unwrap();

    // Upgrade an existing installation while retaining its GitHub identity.
    store
        .database()
        .execute_unprepared(
            "DROP TABLE cp_google_identities; DELETE FROM cp_migrations WHERE version=17",
        )
        .await
        .unwrap();
    deskfleet_control_store::schema::migrate(store.database())
        .await
        .unwrap();
    assert_eq!(
        store.github_account("same-subject").await.unwrap().id,
        github.id
    );
    assert!(matches!(
        store.google_account("same-subject").await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        store
            .google_user("same-subject", "GITHUB@example.test", "Other", true)
            .await,
        Err(Error::Conflict(_))
    ));
    let existing = store
        .verified_user("existing@example.test", "Existing")
        .await
        .unwrap();
    assert!(matches!(
        store
            .google_user("other", "EXISTING@example.test", "Other", true)
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
            .google_user("same-subject", "google@example.test", "Google User", false)
            .await,
        Err(Error::Invalid("terms acceptance required"))
    ));
    let (first, concurrent) = tokio::join!(
        store.google_user("same-subject", "google@example.test", "Google User", true),
        store.google_user("same-subject", "google@example.test", "Google User", true)
    );
    let created = first.unwrap();
    assert_eq!(created.id, concurrent.unwrap().id);
    assert_ne!(created.id, github.id);
    assert_eq!(
        store.google_account("same-subject").await.unwrap().id,
        created.id
    );

    store
        .database()
        .execute_unprepared("UPDATE cp_registration_policy SET enabled=FALSE")
        .await
        .unwrap();
    assert!(matches!(
        store
            .google_user("another-subject", "another@example.test", "Another", true)
            .await,
        Err(Error::Invalid("registration disabled"))
    ));
    let login = store
        .google_user("same-subject", "changed@example.test", "Changed", false)
        .await
        .unwrap();
    assert_eq!(login.id, created.id);
    assert_eq!(login.email.as_deref(), Some("google@example.test"));
    assert_eq!(login.name, "Google User");

    let started = store.authentication_generation().await.unwrap();
    store.revoke_user_sessions(&created.id, None).await.unwrap();
    assert!(matches!(
        store.new_session_at_generation(&created.id, started).await,
        Err(Error::Unauthorized)
    ));
    let restarted = store.authentication_generation().await.unwrap();
    assert!(
        store
            .new_session_at_generation(&created.id, restarted)
            .await
            .is_ok()
    );

    for mutation in ["disabled=TRUE", "disabled=FALSE,email_verified=FALSE"] {
        store
            .database()
            .execute_unprepared(&format!(
                "UPDATE cp_users SET {mutation} WHERE id='{}'",
                created.id
            ))
            .await
            .unwrap();
        assert!(matches!(
            store
                .google_user("same-subject", "google@example.test", "Google User", true)
                .await,
            Err(Error::Unauthorized)
        ));
        assert!(matches!(
            store.google_account("same-subject").await,
            Err(Error::NotFound)
        ));
    }

    store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
