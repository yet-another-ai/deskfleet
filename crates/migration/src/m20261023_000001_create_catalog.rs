use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    fn use_transaction(&self) -> Option<bool> {
        Some(true)
    }

    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.create_table(resource_table("teams")).await?;

        for (table, parent_column, parent_table, foreign_key, index) in [
            (
                "machines",
                "team_id",
                "teams",
                "fk_machines_team",
                "idx_machines_team_id",
            ),
            (
                "workspaces",
                "machine_id",
                "machines",
                "fk_workspaces_machine",
                "idx_workspaces_machine_id",
            ),
        ] {
            manager
                .create_table(
                    resource_table(table)
                        .col(ColumnDef::new(parent_column).big_integer().not_null())
                        .foreign_key(
                            ForeignKey::create()
                                .name(foreign_key)
                                .from(table, parent_column)
                                .to(parent_table, "id")
                                .on_delete(ForeignKeyAction::Restrict)
                                .on_update(ForeignKeyAction::Restrict),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .name(index)
                        .table(table)
                        .col(parent_column)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_table(
                identity_table("workspace_sessions")
                    .col(ColumnDef::new("workspace_id").big_integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_workspace_sessions_workspace")
                            .from("workspace_sessions", "workspace_id")
                            .to("workspaces", "id")
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .index(
                        Index::create()
                            .name("idx_workspace_sessions_owner")
                            .col("id")
                            .col("workspace_id")
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_workspace_sessions_workspace")
                    .table("workspace_sessions")
                    .col("workspace_id")
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                identity_table("worktrees")
                    .col(ColumnDef::new("workspace_id").big_integer().not_null())
                    .col(ColumnDef::new("session_id").big_integer().null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_worktrees_workspace")
                            .from("worktrees", "workspace_id")
                            .to("workspaces", "id")
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_worktrees_session")
                            .from("worktrees", ("session_id", "workspace_id"))
                            .to("workspace_sessions", ("id", "workspace_id"))
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_worktrees_workspace")
                    .table("worktrees")
                    .col("workspace_id")
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_worktrees_session")
                    .table("worktrees")
                    .col("session_id")
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager.create_index(main_worktree_index()).await?;

        manager
            .create_table(
                Table::create()
                    .table("worktree_directories")
                    .col(ColumnDef::new("worktree_id").big_integer().not_null())
                    .col(ColumnDef::new("path").text().not_null())
                    .col(ColumnDef::new("position").integer().not_null())
                    .primary_key(Index::create().col("worktree_id").col("position"))
                    .check(Expr::col("path").ne(""))
                    .check(Expr::col("position").gte(0))
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_worktree_directories_worktree")
                            .from("worktree_directories", "worktree_id")
                            .to("worktrees", "id")
                            .on_delete(ForeignKeyAction::Cascade)
                            .on_update(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in [
            "worktree_directories",
            "worktrees",
            "workspace_sessions",
            "workspaces",
            "machines",
            "teams",
        ] {
            manager
                .drop_table(Table::drop().table(table).to_owned())
                .await?;
        }
        Ok(())
    }
}

fn resource_table(table: &'static str) -> TableCreateStatement {
    identity_table(table)
        .col(ColumnDef::new("name").text().not_null())
        .to_owned()
}

fn main_worktree_index() -> IndexCreateStatement {
    Index::create()
        .name("idx_worktrees_main")
        .table("worktrees")
        .col("workspace_id")
        .unique()
        .and_where(Expr::col("session_id").is_null())
        .to_owned()
}

fn identity_table(table: &'static str) -> TableCreateStatement {
    Table::create()
        .table(table)
        .col(
            ColumnDef::new("id")
                .big_integer()
                .not_null()
                .auto_increment()
                .primary_key(),
        )
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_keys_render_as_postgres_bigint_identity() {
        let sql = resource_table("teams").to_string(PostgresQueryBuilder);
        assert!(sql.contains("\"id\" bigint GENERATED BY DEFAULT AS IDENTITY"));
    }

    #[test]
    fn main_worktree_uniqueness_renders_for_sqlite_and_postgres() {
        for sql in [
            main_worktree_index().to_string(SqliteQueryBuilder),
            main_worktree_index().to_string(PostgresQueryBuilder),
        ] {
            assert!(sql.contains("UNIQUE"));
            assert!(sql.contains("WHERE \"session_id\" IS NULL"));
        }
    }
}
