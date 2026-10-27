use super::*;
use sea_orm_migration::sea_orm::Database;

struct ElicitationBaseline;

#[async_trait::async_trait]
impl MigratorTrait for ElicitationBaseline {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261023_000001_create_catalog::Migration),
            Box::new(m20261023_000002_agent_sessions::Migration),
            Box::new(m20261025_000003_agent_elicitations::Migration),
        ]
    }
}

struct ArchiveBaseline;

#[async_trait::async_trait]
impl MigratorTrait for ArchiveBaseline {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261023_000001_create_catalog::Migration),
            Box::new(m20261023_000002_agent_sessions::Migration),
            Box::new(m20261025_000003_session_archive::Migration),
        ]
    }
}

async fn upgrade_baseline<M: MigratorTrait>() {
    let db = Database::connect("sqlite::memory:").await.unwrap();
    M::up(&db, None).await.unwrap();
    assert_eq!(
        Migrator::get_pending_migrations(&db).await.unwrap().len(),
        2
    );

    Migrator::up(&db, None).await.unwrap();
    let schema = SchemaManager::new(&db);
    assert!(schema.has_table("agent_elicitations").await.unwrap());
    assert!(
        schema
            .has_column("agent_sessions", "archive_state")
            .await
            .unwrap()
    );
    assert!(
        schema
            .has_column("workspace_sessions", "machine_id")
            .await
            .unwrap()
    );
    assert!(
        Migrator::get_pending_migrations(&db)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        Migrator::get_applied_migrations(&db).await.unwrap().len(),
        5
    );

    Migrator::down(&db, None).await.unwrap();
    assert!(!schema.has_table("agent_elicitations").await.unwrap());
    assert!(!schema.has_table("agent_sessions").await.unwrap());
    Migrator::up(&db, None).await.unwrap();
    assert!(schema.has_table("agent_elicitations").await.unwrap());
    assert!(
        schema
            .has_column("agent_sessions", "archive_state")
            .await
            .unwrap()
    );
    db.close().await.unwrap();
}

#[tokio::test]
async fn elicitation_catalog_upgrades_with_archive_state() {
    upgrade_baseline::<ElicitationBaseline>().await;
}

#[tokio::test]
async fn archive_catalog_upgrades_with_elicitations() {
    upgrade_baseline::<ArchiveBaseline>().await;
}
