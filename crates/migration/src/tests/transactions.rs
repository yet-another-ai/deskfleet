use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use sea_orm_migration::sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, QueryResult,
    Statement,
};

use crate::{Migrator, MigratorTrait, SchemaManager};

struct FileDatabase(PathBuf);
static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);

impl FileDatabase {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_DATABASE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "deskfleet-migration-{}-{nonce}-{id}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        Self(directory)
    }

    async fn connect(&self) -> DatabaseConnection {
        let path = self.0.join("catalog.db");
        let mut options = ConnectOptions::new("sqlite:");
        options.max_connections(1).sqlx_logging(false);
        options.map_sqlx_sqlite_opts(move |options| {
            options
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true)
        });
        Database::connect(options).await.unwrap()
    }
}

impl Drop for FileDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn query(db: &DatabaseConnection, sql: &str) -> QueryResult {
    db.query_one_raw(Statement::from_string(DbBackend::Sqlite, sql))
        .await
        .unwrap()
        .unwrap()
}

async fn count(db: &DatabaseConnection, sql: &str) -> i64 {
    query(db, sql).await.try_get("", "count").unwrap()
}

#[tokio::test]
async fn failed_query_index_upgrade_rolls_back_schema_and_history() {
    let file = FileDatabase::new();
    let db = file.connect().await;
    Migrator::up(&db, Some(5)).await.unwrap();
    db.execute_unprepared(
        "INSERT INTO agent_commands (id, state, record_json, operation_id, is_canonical) \
         VALUES (1, 'completed', '{\"sessionId\":\"10\"}', 'original', TRUE); \
         CREATE TABLE index_conflict (id INTEGER); \
         CREATE INDEX idx_agent_commands_revision ON index_conflict (id);",
    )
    .await
    .unwrap();

    // Fail after this migration has added its column, table, and allocator row.
    let error = Migrator::up(&db, None).await.unwrap_err();
    assert!(error.to_string().contains("idx_agent_commands_revision"));
    let schema = SchemaManager::new(&db);
    assert!(
        !schema
            .has_column("agent_commands", "revision")
            .await
            .unwrap()
    );
    assert!(!schema.has_table("agent_command_revisions").await.unwrap());
    assert_eq!(
        Migrator::get_applied_migrations(&db).await.unwrap().len(),
        5
    );
    assert_eq!(
        Migrator::get_pending_migrations(&db).await.unwrap().len(),
        1
    );
    assert_eq!(
        query(&db, "SELECT record_json FROM agent_commands WHERE id = 1")
            .await
            .try_get::<String>("", "record_json")
            .unwrap(),
        "{\"sessionId\":\"10\"}"
    );
    db.execute_unprepared("DROP INDEX idx_agent_commands_revision")
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    db.close().await.unwrap();

    let db = file.connect().await;
    assert!(
        Migrator::get_pending_migrations(&db)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        query(&db, "SELECT revision FROM agent_commands WHERE id = 1")
            .await
            .try_get::<i64>("", "revision")
            .unwrap(),
        0
    );
    db.close().await.unwrap();
}

#[tokio::test]
async fn populated_catalog_upgrade_preserves_foreign_keys_and_durability() {
    let file = FileDatabase::new();
    let db = file.connect().await;
    Migrator::up(&db, Some(4)).await.unwrap();
    db.execute_unprepared(
        "INSERT INTO teams (id, name) VALUES (1, 'Local'); \
         INSERT INTO machines (id, team_id, name) VALUES (1, 1, 'machine'); \
         INSERT INTO workspaces (id, machine_id, name) VALUES (1, 1, 'workspace'); \
         INSERT INTO workspace_sessions (id, workspace_id) VALUES (1, 1); \
         INSERT INTO worktrees (id, workspace_id, session_id) VALUES (1, 1, NULL), (2, 1, 1); \
         INSERT INTO worktree_directories (worktree_id, path, position) VALUES (1, '/main', 0), (2, '/session', 0); \
         INSERT INTO agent_sessions (session_id, lifecycle, last_event_seq, record_json) VALUES (1, 'active', 1, '{\"title\":\"kept\"}'); \
         INSERT INTO agent_runs (session_id, generation, state, record_json) VALUES (1, 1, 'completed', '{}'); \
         INSERT INTO agent_events (session_id, seq, run_generation, record_json) VALUES (1, 1, 1, '{\"event\":\"kept\"}'); \
         INSERT INTO agent_commands (id, state, record_json, operation_id, is_canonical, session_id) \
         VALUES (1, 'completed', '{\"sessionId\":\"1\"}', 'kept', TRUE, 1);",
    ).await.unwrap();
    Migrator::up(&db, None).await.unwrap();
    // Check the migration's own connection before reopening can reset PRAGMAs.
    assert_eq!(
        query(&db, "PRAGMA synchronous")
            .await
            .try_get::<i64>("", "synchronous")
            .unwrap(),
        2
    );
    assert_eq!(
        query(&db, "PRAGMA foreign_keys")
            .await
            .try_get::<i64>("", "foreign_keys")
            .unwrap(),
        1
    );
    db.close().await.unwrap();

    let db = file.connect().await;
    assert_eq!(
        Migrator::get_applied_migrations(&db).await.unwrap().len(),
        6
    );
    assert!(
        Migrator::get_pending_migrations(&db)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        query(&db, "PRAGMA synchronous")
            .await
            .try_get::<i64>("", "synchronous")
            .unwrap(),
        2
    );
    assert_eq!(
        query(&db, "PRAGMA foreign_keys")
            .await
            .try_get::<i64>("", "foreign_keys")
            .unwrap(),
        1
    );
    assert!(
        db.query_all_raw(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA foreign_key_check"
        ))
        .await
        .unwrap()
        .is_empty()
    );
    let session = query(
        &db,
        "SELECT machine_id, workspace_id FROM workspace_sessions WHERE id = 1",
    )
    .await;
    assert_eq!(session.try_get::<i64>("", "machine_id").unwrap(), 1);
    assert_eq!(session.try_get::<i64>("", "workspace_id").unwrap(), 1);
    assert_eq!(count(&db, "SELECT COUNT(*) AS count FROM worktree_directories WHERE (worktree_id = 1 AND path = '/main') OR (worktree_id = 2 AND path = '/session')").await, 2);
    assert_eq!(
        query(
            &db,
            "SELECT record_json FROM agent_sessions WHERE session_id = 1"
        )
        .await
        .try_get::<String>("", "record_json")
        .unwrap(),
        "{\"title\":\"kept\"}"
    );
    assert_eq!(
        query(
            &db,
            "SELECT record_json FROM agent_events WHERE session_id = 1 AND seq = 1"
        )
        .await
        .try_get::<String>("", "record_json")
        .unwrap(),
        "{\"event\":\"kept\"}"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) AS count FROM agent_runs WHERE session_id = 1 AND generation = 1"
        )
        .await,
        1
    );
    assert_eq!(
        query(&db, "SELECT session_id FROM agent_commands WHERE id = 1")
            .await
            .try_get::<i64>("", "session_id")
            .unwrap(),
        1
    );

    assert!(
        db.execute_unprepared("DELETE FROM workspaces WHERE id = 1")
            .await
            .is_err()
    );
    db.execute_unprepared("DELETE FROM workspace_sessions WHERE id = 1")
        .await
        .unwrap();
    assert_eq!(
        count(&db, "SELECT COUNT(*) AS count FROM worktrees WHERE id = 2").await,
        0
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) AS count FROM worktree_directories WHERE worktree_id = 2"
        )
        .await,
        0
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) AS count FROM agent_sessions").await,
        0
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) AS count FROM agent_runs").await,
        0
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) AS count FROM agent_events").await,
        0
    );
    assert_eq!(
        query(&db, "SELECT session_id FROM agent_commands WHERE id = 1")
            .await
            .try_get::<Option<i64>>("", "session_id")
            .unwrap(),
        None
    );
    db.execute_unprepared("DELETE FROM workspaces WHERE id = 1")
        .await
        .unwrap();
    assert_eq!(
        count(&db, "SELECT COUNT(*) AS count FROM worktree_directories").await,
        0
    );
    db.close().await.unwrap();
}
