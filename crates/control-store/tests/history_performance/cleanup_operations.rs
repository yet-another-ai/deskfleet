use super::{Fixture, event, snapshot};
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{ConnectionTrait, DbBackend, Statement};

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn cleanup_connection_does_not_apply_migrations() {
    let fixture = Fixture::new().await;
    fixture
        .store
        .database()
        .execute_unprepared("DELETE FROM cp_migrations WHERE version=31")
        .await
        .unwrap();
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let url = format!("{url}{separator}options=-csearch_path%3D{}", fixture.schema);
    assert!(matches!(
        ControlStore::connect_for_cleanup(&url).await,
        Err(Error::Invalid(_))
    ));
    let row = fixture
        .store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT count(*) AS count FROM cp_migrations WHERE version=31",
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn explicit_history_vacuum_preserves_readable_history() {
    let fixture = Fixture::new().await;
    fixture
        .store
        .sync_history(
            &fixture.machine,
            "1",
            snapshot("1", "1", "active"),
            vec![event("1")],
            vec![],
        )
        .await
        .unwrap();
    assert!(fixture.store.storage_size_bytes().await.unwrap() > 0);
    for full in [false, true] {
        fixture.store.vacuum_history(full).await.unwrap();
        let history = fixture
            .store
            .events(&fixture.machine, "1", 0, 10)
            .await
            .unwrap();
        assert_eq!(history["events"].as_array().unwrap().len(), 1);
        assert_eq!(history["lastEventSeq"], "1");
    }
    fixture.close().await;
}
