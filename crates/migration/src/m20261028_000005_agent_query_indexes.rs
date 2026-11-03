use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(AgentCommand::Table)
                    .add_column(
                        ColumnDef::new(AgentCommand::Revision)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(AgentCommandRevision::Table)
                    .col(
                        ColumnDef::new(AgentCommandRevision::Id)
                            .integer()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(AgentCommandRevision::LastRevision)
                            .integer()
                            .not_null(),
                    )
                    .check(Expr::col(AgentCommandRevision::Id).eq(1))
                    .check(Expr::col(AgentCommandRevision::LastRevision).gte(0))
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute(
                Query::insert()
                    .into_table(AgentCommandRevision::Table)
                    .columns([AgentCommandRevision::Id, AgentCommandRevision::LastRevision])
                    .values_panic([1.into(), 0.into()]),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_agent_commands_revision")
                    .table(AgentCommand::Table)
                    .col(AgentCommand::SessionId)
                    .col(AgentCommand::Revision)
                    .to_owned(),
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
        // SeaQuery's SQLite backend does not support expression index columns.
        // Keep this static DDL in the migration; runtime queries use typed expressions.
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
            .drop_table(Table::drop().table(AgentCommandRevision::Table).to_owned())
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(AgentCommand::Table)
                    .drop_column(AgentCommand::Revision)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum AgentCommand {
    #[sea_orm(iden = "agent_commands")]
    Table,
    SessionId,
    Revision,
}

#[derive(DeriveIden)]
enum AgentCommandRevision {
    #[sea_orm(iden = "agent_command_revisions")]
    Table,
    Id,
    LastRevision,
}
