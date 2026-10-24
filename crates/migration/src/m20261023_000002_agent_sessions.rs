use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table("catalog_identity")
                    .col(ColumnDef::new("id").integer().primary_key())
                    .col(ColumnDef::new("origin_id").text().not_null().unique_key())
                    .check(Expr::col("id").eq(1))
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table("agent_id_allocator")
                    .col(ColumnDef::new("id").integer().primary_key())
                    .col(ColumnDef::new("last_id").big_integer().not_null())
                    .check(Expr::col("id").eq(1))
                    .check(Expr::col("last_id").gte(0))
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table("agent_sessions")
                    .col(ColumnDef::new("session_id").big_integer().primary_key())
                    .col(ColumnDef::new("lifecycle").text().not_null())
                    .col(ColumnDef::new("last_event_seq").big_integer().not_null())
                    .col(record())
                    .check(Expr::col("last_event_seq").gte(0))
                    .foreign_key(&mut session_fk(
                        "agent_sessions",
                        "workspace_sessions",
                        "id",
                    ))
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table("agent_runs")
                    .col(ColumnDef::new("session_id").big_integer().not_null())
                    .col(ColumnDef::new("generation").big_integer().not_null())
                    .col(state())
                    .col(record())
                    .primary_key(Index::create().col("session_id").col("generation"))
                    .check(Expr::col("generation").gt(0))
                    .foreign_key(&mut session_fk(
                        "agent_runs",
                        "agent_sessions",
                        "session_id",
                    ))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(active_index(
                "agent_runs",
                &["starting", "running", "stopping"],
            ))
            .await?;
        manager
            .create_table(
                domain_table("agent_commands")
                    .col(ColumnDef::new("operation_id").text().not_null())
                    .col(ColumnDef::new("is_canonical").boolean().not_null())
                    .col(ColumnDef::new("session_id").big_integer().null())
                    .col(
                        ColumnDef::new("conflicting_command_id")
                            .big_integer()
                            .null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from("agent_commands", "session_id")
                            .to("workspace_sessions", "id")
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from("agent_commands", "conflicting_command_id")
                            .to("agent_commands", "id")
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_agent_commands_operation")
                    .table("agent_commands")
                    .col("operation_id")
                    .unique()
                    .and_where(Expr::col("is_canonical").eq(true))
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                owned_table("agent_inputs")
                    .col(
                        ColumnDef::new("submission_command_id")
                            .big_integer()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new("accepted_seq").big_integer().not_null())
                    .col(ColumnDef::new("dispatch_command_id").big_integer().null())
                    .foreign_key(&mut command_fk("agent_inputs", "submission_command_id"))
                    .foreign_key(&mut command_fk("agent_inputs", "dispatch_command_id"))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_agent_inputs_pending")
                    .table("agent_inputs")
                    .col("session_id")
                    .col("accepted_seq")
                    .and_where(Expr::col("state").eq("pending"))
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                owned_table("agent_turns")
                    .col(ColumnDef::new("initial_input_id").big_integer().not_null())
                    .col(
                        ColumnDef::new("initial_dispatch_command_id")
                            .big_integer()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new("run_generation").big_integer().not_null())
                    .foreign_key(&mut owned_fk(
                        "agent_turns",
                        "initial_input_id",
                        "agent_inputs",
                    ))
                    .foreign_key(&mut command_fk(
                        "agent_turns",
                        "initial_dispatch_command_id",
                    ))
                    .foreign_key(&mut run_fk("agent_turns"))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(active_index(
                "agent_turns",
                &["starting", "running", "cancelling"],
            ))
            .await?;
        manager
            .create_table(
                owned_table("agent_permissions")
                    .col(ColumnDef::new("run_generation").big_integer().not_null())
                    .col(ColumnDef::new("turn_id").big_integer().null())
                    .col(ColumnDef::new("decision_command_id").big_integer().null())
                    .foreign_key(&mut run_fk("agent_permissions"))
                    .foreign_key(&mut owned_fk("agent_permissions", "turn_id", "agent_turns"))
                    .foreign_key(&mut command_fk("agent_permissions", "decision_command_id"))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_agent_permissions_pending")
                    .table("agent_permissions")
                    .col("session_id")
                    .and_where(Expr::col("state").eq("pending"))
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table("agent_events")
                    .col(ColumnDef::new("session_id").big_integer().not_null())
                    .col(ColumnDef::new("seq").big_integer().not_null())
                    .col(ColumnDef::new("run_generation").big_integer().null())
                    .col(ColumnDef::new("turn_id").big_integer().null())
                    .col(ColumnDef::new("input_id").big_integer().null())
                    .col(ColumnDef::new("command_id").big_integer().null())
                    .col(record())
                    .primary_key(Index::create().col("session_id").col("seq"))
                    .check(Expr::col("seq").gt(0))
                    .foreign_key(&mut session_fk(
                        "agent_events",
                        "agent_sessions",
                        "session_id",
                    ))
                    .foreign_key(&mut run_fk("agent_events"))
                    .foreign_key(&mut owned_fk("agent_events", "turn_id", "agent_turns"))
                    .foreign_key(&mut owned_fk("agent_events", "input_id", "agent_inputs"))
                    .foreign_key(&mut command_fk("agent_events", "command_id"))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in [
            "agent_events",
            "agent_permissions",
            "agent_turns",
            "agent_inputs",
            "agent_commands",
            "agent_runs",
            "agent_sessions",
            "agent_id_allocator",
            "catalog_identity",
        ] {
            manager
                .drop_table(Table::drop().table(table).to_owned())
                .await?;
        }
        Ok(())
    }
}

fn record() -> ColumnDef {
    ColumnDef::new("record_json").text().not_null().to_owned()
}
fn state() -> ColumnDef {
    ColumnDef::new("state").text().not_null().to_owned()
}

fn domain_table(table: &'static str) -> TableCreateStatement {
    Table::create()
        .table(table)
        .col(ColumnDef::new("id").big_integer().primary_key())
        .col(state())
        .col(record())
        .to_owned()
}

fn owned_table(table: &'static str) -> TableCreateStatement {
    domain_table(table)
        .col(ColumnDef::new("session_id").big_integer().not_null())
        .index(Index::create().col("id").col("session_id").unique())
        .foreign_key(&mut session_fk(table, "agent_sessions", "session_id"))
        .to_owned()
}

fn session_fk(
    table: &'static str,
    parent: &'static str,
    column: &'static str,
) -> ForeignKeyCreateStatement {
    ForeignKey::create()
        .from(table, "session_id")
        .to(parent, column)
        .on_delete(ForeignKeyAction::Cascade)
        .to_owned()
}

fn command_fk(table: &'static str, column: &'static str) -> ForeignKeyCreateStatement {
    ForeignKey::create()
        .from(table, column)
        .to("agent_commands", "id")
        .on_delete(ForeignKeyAction::Restrict)
        .to_owned()
}

fn owned_fk(
    table: &'static str,
    column: &'static str,
    parent: &'static str,
) -> ForeignKeyCreateStatement {
    ForeignKey::create()
        .from(table, (column, "session_id"))
        .to(parent, ("id", "session_id"))
        .on_delete(ForeignKeyAction::Cascade)
        .to_owned()
}

fn run_fk(table: &'static str) -> ForeignKeyCreateStatement {
    ForeignKey::create()
        .from(table, ("session_id", "run_generation"))
        .to("agent_runs", ("session_id", "generation"))
        .on_delete(ForeignKeyAction::Cascade)
        .to_owned()
}

fn active_index(table: &'static str, states: &[&str]) -> IndexCreateStatement {
    Index::create()
        .name(format!("idx_{table}_active"))
        .table(table)
        .col("session_id")
        .unique()
        .and_where(Expr::col("state").is_in(states.iter().copied()))
        .to_owned()
}
