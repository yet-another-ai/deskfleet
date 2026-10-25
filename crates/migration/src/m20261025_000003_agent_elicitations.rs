use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table("agent_elicitations")
                    .col(ColumnDef::new("id").big_integer().primary_key())
                    .col(ColumnDef::new("session_id").big_integer().not_null())
                    .col(ColumnDef::new("run_generation").big_integer().not_null())
                    .col(ColumnDef::new("turn_id").big_integer().null())
                    .col(ColumnDef::new("decision_command_id").big_integer().null())
                    .col(ColumnDef::new("state").text().not_null())
                    .col(ColumnDef::new("record_json").text().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from("agent_elicitations", "session_id")
                            .to("agent_sessions", "session_id")
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from("agent_elicitations", ("session_id", "run_generation"))
                            .to("agent_runs", ("session_id", "generation"))
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from("agent_elicitations", ("turn_id", "session_id"))
                            .to("agent_turns", ("id", "session_id"))
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from("agent_elicitations", "decision_command_id")
                            .to("agent_commands", "id")
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_agent_elicitations_pending")
                    .table("agent_elicitations")
                    .col("session_id")
                    .and_where(Expr::col("state").eq("pending"))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table("agent_elicitations").to_owned())
            .await
    }
}
