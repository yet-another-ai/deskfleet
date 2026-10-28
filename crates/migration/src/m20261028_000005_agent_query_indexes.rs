use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE agent_commands ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; \
                 CREATE TABLE agent_command_revisions (id INTEGER PRIMARY KEY CHECK (id = 1), \
                 last_revision INTEGER NOT NULL CHECK (last_revision >= 0)); \
                 INSERT INTO agent_command_revisions (id, last_revision) VALUES (1, 0); \
                 CREATE INDEX idx_agent_commands_revision ON agent_commands (session_id, revision)",
            )
            .await?;
        for (table, columns) in [
            ("agent_inputs", &["session_id", "accepted_seq", "id"][..]),
            ("agent_turns", &["session_id", "id"][..]),
            ("agent_permissions", &["session_id", "id"][..]),
            ("agent_elicitations", &["session_id", "id"][..]),
            ("agent_commands", &["session_id", "id"][..]),
        ] {
            let mut index = Index::create();
            index.name(format!("idx_{table}_session")).table(table);
            for column in columns {
                index.col(*column);
            }
            manager.create_index(index.to_owned()).await?;
        }
        // The live Session FK becomes NULL on deletion; immutable audit JSON
        // retains the Session identity needed to reconcile lost quota releases.
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE INDEX idx_agent_commands_deleted_session ON agent_commands \
                 (json_extract(record_json, '$.sessionId')) WHERE session_id IS NULL",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for name in [
            "idx_agent_commands_deleted_session",
            "idx_agent_commands_session",
            "idx_agent_elicitations_session",
            "idx_agent_permissions_session",
            "idx_agent_turns_session",
            "idx_agent_inputs_session",
            "idx_agent_commands_revision",
        ] {
            manager
                .drop_index(Index::drop().name(name).to_owned())
                .await?;
        }
        manager
            .get_connection()
            .execute_unprepared(
                "DROP TABLE agent_command_revisions; ALTER TABLE agent_commands DROP COLUMN revision",
            )
            .await?;
        Ok(())
    }
}
