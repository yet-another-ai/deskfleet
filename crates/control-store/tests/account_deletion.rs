//! Account deletion request, review, and anonymization invariants.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};

async fn fixture() -> (ControlStore, DatabaseConnection, String, String, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let db = Database::connect(&url).await.unwrap();
    let schema = format!("account_deletion_{}", uuid::Uuid::new_v4().simple());
    db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let admin = store
        .verified_user("admin@deletion.test", "Admin")
        .await
        .unwrap();
    store.grant_site_admin(&admin.id).await.unwrap();
    let target = store
        .verified_user("target@deletion.test", "Target")
        .await
        .unwrap();
    (store, db, schema, admin.id, target.id)
}

async fn cleanup(store: ControlStore, db: DatabaseConnection, schema: String) {
    store.close().await.unwrap();
    db.execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    db.close().await.unwrap();
}

async fn user_record(store: &ControlStore, id: &str) -> serde_json::Value {
    store
        .database()
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT to_jsonb(u) AS record FROM cp_users u WHERE id=$1",
            vec![id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "record")
        .unwrap()
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn approval_anonymizes_the_account_and_revokes_access() {
    let (store, db, schema, admin, target) = fixture().await;
    let request = store
        .request_account_deletion(&target, "Moving on")
        .await
        .unwrap();
    assert_eq!(request["status"], "pending");
    assert!(matches!(
        store.request_account_deletion(&target, "Again").await,
        Err(Error::Conflict(_))
    ));
    let page = store
        .account_deletion_requests(&admin, None, 20)
        .await
        .unwrap();
    assert_eq!(page["requests"][0]["user"]["id"], target);
    assert_eq!(page["requests"][0]["reason"], "Moving on");

    let team = store.create_team(&admin, "Shared").await.unwrap();
    let invite = store
        .invite(&admin, &team.id, "target@deletion.test", "member")
        .await
        .unwrap();
    store
        .accept_invite(&target, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    let session = store.new_session(&target).await.unwrap();

    let (deleted, peers) = store
        .review_account_deletion(
            &admin,
            request["id"].as_str().unwrap(),
            true,
            Some("Verified"),
        )
        .await
        .unwrap();
    assert_eq!(deleted, target);
    assert!(peers.is_empty());
    assert!(
        !store
            .session_is_active(session["id"].as_str().unwrap())
            .await
            .unwrap()
    );
    let user = user_record(&store, &target).await;
    assert_eq!(user["disabled"], true);
    assert_eq!(user["name"], "Deleted account");
    assert_eq!(user["email"], format!("deleted+{target}@invalid"));
    assert!(user["deleted_at"].is_number());
    assert!(user["password_hash"].is_null());
    assert!(
        store
            .find_accounts(&admin, "target@deletion.test")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .account_deletion_request(&target)
            .await
            .unwrap()
            .unwrap()["status"],
        "approved"
    );
    assert!(matches!(
        store
            .review_account_deletion(&admin, request["id"].as_str().unwrap(), true, None)
            .await,
        Err(Error::Conflict(_))
    ));
    cleanup(store, db, schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn team_owners_and_rejected_requests_keep_their_accounts() {
    let (store, db, schema, admin, target) = fixture().await;
    store.create_team(&target, "Owned").await.unwrap();
    let request = store
        .request_account_deletion(&target, "Please remove")
        .await
        .unwrap();
    assert!(matches!(
        store
            .review_account_deletion(&admin, request["id"].as_str().unwrap(), true, None)
            .await,
        Err(Error::Conflict(_))
    ));
    assert!(
        !user_record(&store, &target).await["disabled"]
            .as_bool()
            .unwrap()
    );

    store
        .review_account_deletion(
            &admin,
            request["id"].as_str().unwrap(),
            false,
            Some("Transfer ownership first"),
        )
        .await
        .unwrap();
    let latest = store
        .account_deletion_request(&target)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest["status"], "rejected");
    assert_eq!(latest["reviewNote"], "Transfer ownership first");
    assert!(
        !user_record(&store, &target).await["disabled"]
            .as_bool()
            .unwrap()
    );
    cleanup(store, db, schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn request_validation_and_cancellation_are_bounded() {
    let (store, db, schema, admin, target) = fixture().await;
    assert!(
        store
            .request_account_deletion(&target, "   ")
            .await
            .is_err()
    );
    assert!(
        store
            .request_account_deletion(&target, &"x".repeat(2001))
            .await
            .is_err()
    );
    let request = store
        .request_account_deletion(&target, "Need a break")
        .await
        .unwrap();
    store.cancel_account_deletion(&target).await.unwrap();
    let latest = store
        .account_deletion_request(&target)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest["id"], request["id"]);
    assert_eq!(latest["status"], "cancelled");
    assert!(
        store
            .account_deletion_requests(&admin, None, 20)
            .await
            .unwrap()["requests"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    cleanup(store, db, schema).await;
}
