use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    // SQLite ignores PRAGMA foreign_keys inside an open transaction.
    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }

    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("PRAGMA foreign_keys = OFF").await?;
        // Session ownership can be machine-scoped when no Workspace is selected.
        db.execute_unprepared(
            "CREATE TABLE workspace_sessions_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                workspace_id INTEGER NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
                machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE RESTRICT
            )",
        )
        .await?;
        db.execute_unprepared(
            "INSERT INTO workspace_sessions_new (id, workspace_id, machine_id)
             SELECT s.id, s.workspace_id, w.machine_id
             FROM workspace_sessions s
             JOIN workspaces w ON w.id = s.workspace_id",
        )
        .await?;
        db.execute_unprepared("DROP TABLE workspace_sessions")
            .await?;
        db.execute_unprepared("ALTER TABLE workspace_sessions_new RENAME TO workspace_sessions")
            .await?;
        db.execute_unprepared(
            "CREATE INDEX idx_workspace_sessions_workspace ON workspace_sessions (workspace_id)",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX idx_workspace_sessions_machine ON workspace_sessions (machine_id)",
        )
        .await?;

        db.execute_unprepared(
            "CREATE TABLE worktrees_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                workspace_id INTEGER NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                session_id INTEGER NULL UNIQUE REFERENCES workspace_sessions(id) ON DELETE CASCADE
            )",
        )
        .await?;
        db.execute_unprepared(
            "INSERT INTO worktrees_new (id, workspace_id, session_id)
             SELECT id, workspace_id, session_id FROM worktrees",
        )
        .await?;
        db.execute_unprepared("DROP TABLE worktrees").await?;
        db.execute_unprepared("ALTER TABLE worktrees_new RENAME TO worktrees")
            .await?;
        db.execute_unprepared("CREATE INDEX idx_worktrees_workspace ON worktrees (workspace_id)")
            .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX idx_worktrees_main ON worktrees (workspace_id)
             WHERE session_id IS NULL",
        )
        .await?;
        db.execute_unprepared("PRAGMA foreign_keys = ON").await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("PRAGMA foreign_keys = OFF").await?;
        db.execute_unprepared(
            "CREATE TABLE worktrees_old (
                id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                session_id INTEGER NULL UNIQUE
            )",
        )
        .await?;
        db.execute_unprepared(
            "INSERT INTO worktrees_old (id, workspace_id, session_id)
             SELECT id, workspace_id, session_id FROM worktrees
             WHERE workspace_id IS NOT NULL",
        )
        .await?;
        db.execute_unprepared("DROP TABLE worktrees").await?;
        db.execute_unprepared("ALTER TABLE worktrees_old RENAME TO worktrees")
            .await?;
        db.execute_unprepared("CREATE INDEX idx_worktrees_workspace ON worktrees (workspace_id)")
            .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX idx_worktrees_main ON worktrees (workspace_id)
             WHERE session_id IS NULL",
        )
        .await?;

        db.execute_unprepared(
            "CREATE TABLE workspace_sessions_old (
                id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT
            )",
        )
        .await?;
        db.execute_unprepared(
            "INSERT INTO workspace_sessions_old (id, workspace_id)
             SELECT id, workspace_id FROM workspace_sessions
             WHERE workspace_id IS NOT NULL",
        )
        .await?;
        db.execute_unprepared("DROP TABLE workspace_sessions")
            .await?;
        db.execute_unprepared("ALTER TABLE workspace_sessions_old RENAME TO workspace_sessions")
            .await?;
        db.execute_unprepared(
            "CREATE INDEX idx_workspace_sessions_workspace ON workspace_sessions (workspace_id)",
        )
        .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX idx_workspace_sessions_owner ON workspace_sessions (id, workspace_id)",
        )
        .await?;
        db.execute_unprepared("PRAGMA foreign_keys = ON").await?;
        Ok(())
    }
}
