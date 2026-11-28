use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum SuperAgentState {
    Table,
    UserId,
    Revision,
    StateJson,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    fn use_transaction(&self) -> Option<bool> {
        Some(true)
    }

    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SuperAgentState::Table)
                    .col(ColumnDef::new(SuperAgentState::UserId).text().primary_key())
                    .col(
                        ColumnDef::new(SuperAgentState::Revision)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SuperAgentState::StateJson).text().not_null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SuperAgentState::Table).to_owned())
            .await
    }
}
