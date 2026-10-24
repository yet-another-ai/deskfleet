use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table("agent_sessions")
                    .add_column(
                        ColumnDef::new("archive_state")
                            .text()
                            .not_null()
                            .default("active"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table("agent_sessions")
                    .drop_column("archive_state")
                    .to_owned(),
            )
            .await
    }
}
