//! Admin-provisioned verified accounts and their audit boundary.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};

async fn fixture() -> (ControlStore, DatabaseConnection, String, String, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let db = Database::connect(&url).await.unwrap();
    let schema = format!("account_creation_{}", uuid::Uuid::new_v4().simple());
    db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let admin = store
        .verified_user("admin@creation.test", "Admin")
        .await
        .unwrap();
    store.grant_site_admin(&admin.id).await.unwrap();
    let member = store
        .verified_user("member@creation.test", "Member")
        .await
        .unwrap();
    (store, db, schema, admin.id, member.id)
}

async fn cleanup(store: ControlStore, db: DatabaseConnection, schema: String) {
    store.close().await.unwrap();
    db.execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    db.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn administrators_provision_verified_password_accounts() {
    let (store, db, schema, admin, member) = fixture().await;
    let user = store
        .create_account(&admin, "newuser@creation.test", "New User", "hash")
        .await
        .unwrap();
    assert_eq!(user.name, "New User");
    assert_eq!(user.email.as_deref(), Some("newuser@creation.test"));
    let credentials = store
        .password_credentials("newuser@creation.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(credentials["userId"], user.id);
    assert_eq!(credentials["passwordHash"], "hash");
    let audit = store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT to_jsonb(a) AS record FROM cp_site_audit a WHERE action='account.create'",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<serde_json::Value>("", "record")
        .unwrap();
    assert_eq!(audit["actor_user_id"], admin);
    assert_eq!(audit["target_user_id"], user.id);
    assert!(audit["after_value"].get("password").is_none());
    assert_eq!(
        store
            .find_accounts(&admin, "newuser@creation.test")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(matches!(
        store
            .create_account(&admin, "newuser@creation.test", "Duplicate", "hash")
            .await,
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        store
            .create_account(&member, "other@creation.test", "Other", "hash")
            .await,
        Err(Error::Forbidden)
    ));
    cleanup(store, db, schema).await;
}
