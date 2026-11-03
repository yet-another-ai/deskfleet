use super::queries;
use crate::LocalCatalog;
use sea_orm::{ConnectionTrait, sea_query::SelectStatement};

#[tokio::test]
async fn session_queries_seek_full_indexes_without_sorting() {
    let local = LocalCatalog::open_in_memory("plans").await.unwrap();
    for (query, table) in [
        (queries::inputs(1), "agent_inputs"),
        (queries::turns(1), "agent_turns"),
        (queries::permissions(1), "agent_permissions"),
        (queries::elicitations(1), "agent_elicitations"),
        (queries::commands(1), "agent_commands"),
    ] {
        let plan = plan(&local, query).await;
        assert!(
            plan.contains(&format!("SEARCH {table} USING INDEX idx_{table}_session")),
            "{table}: {plan}"
        );
        assert!(!plan.contains("TEMP B-TREE"), "{table}: {plan}");
    }
    local.close().await.unwrap();
}

#[tokio::test]
async fn canonical_and_deleted_receipt_queries_seek_their_partial_indexes() {
    let local = LocalCatalog::open_in_memory("plans").await.unwrap();
    let canonical = plan(&local, queries::command("operation")).await;
    assert!(
        canonical.contains("SEARCH agent_commands USING INDEX idx_agent_commands_operation"),
        "{canonical}"
    );
    let deleted = plan(&local, queries::deleted_admission(1)).await;
    assert!(
        deleted.contains("SEARCH agent_commands USING INDEX idx_agent_commands_deleted_session"),
        "{deleted}"
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn command_revision_query_seeks_the_session_and_revision_range() {
    let local = LocalCatalog::open_in_memory("plans").await.unwrap();
    let plan = plan(&local, queries::command_changes(1, 100)).await;
    assert!(
        plan.contains("SEARCH agent_commands USING INDEX idx_agent_commands_revision"),
        "{plan}"
    );
    assert!(plan.contains("revision>?"), "{plan}");
    assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    local.close().await.unwrap();
}

async fn plan(local: &LocalCatalog, query: SelectStatement) -> String {
    let db = local.catalog.database();
    let mut statement = db.get_database_backend().build(&query);
    // EXPLAIN is a test diagnostic; the query and bindings are produced by SeaQuery.
    statement.sql = format!("EXPLAIN QUERY PLAN {}", statement.sql);
    db.query_all_raw(statement)
        .await
        .unwrap()
        .iter()
        .map(|row| row.try_get::<String>("", "detail").unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}
