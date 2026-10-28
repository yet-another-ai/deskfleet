use super::{sql, statement};
use crate::LocalCatalog;
use sea_orm::{ConnectionTrait, Value};

#[tokio::test]
async fn session_queries_seek_full_indexes_without_sorting() {
    let local = LocalCatalog::open_in_memory("plans").await.unwrap();
    for (query, table) in [
        (sql::INPUTS, "agent_inputs"),
        (sql::TURNS, "agent_turns"),
        (sql::PERMISSIONS, "agent_permissions"),
        (sql::ELICITATIONS, "agent_elicitations"),
        (sql::COMMANDS, "agent_commands"),
    ] {
        let plan = plan(&local, query, 1.into()).await;
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
    let canonical = plan(&local, sql::COMMAND, "operation".into()).await;
    assert!(
        canonical.contains("SEARCH agent_commands USING INDEX idx_agent_commands_operation"),
        "{canonical}"
    );
    let deleted = plan(&local, sql::DELETED_ADMISSION, "1".into()).await;
    assert!(
        deleted.contains("SEARCH agent_commands USING INDEX idx_agent_commands_deleted_session"),
        "{deleted}"
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn command_revision_query_seeks_the_session_and_revision_range() {
    let local = LocalCatalog::open_in_memory("plans").await.unwrap();
    let rows = local
        .catalog
        .database()
        .query_all_raw(statement(
            format!("EXPLAIN QUERY PLAN {}", sql::COMMAND_CHANGES),
            vec![1.into(), 100.into()],
        ))
        .await
        .unwrap();
    let plan = rows
        .iter()
        .map(|row| row.try_get::<String>("", "detail").unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        plan.contains("SEARCH agent_commands USING INDEX idx_agent_commands_revision"),
        "{plan}"
    );
    assert!(plan.contains("revision>?"), "{plan}");
    assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    local.close().await.unwrap();
}

async fn plan(local: &LocalCatalog, query: &str, value: Value) -> String {
    local
        .catalog
        .database()
        .query_all_raw(statement(
            format!("EXPLAIN QUERY PLAN {query}"),
            vec![value],
        ))
        .await
        .unwrap()
        .iter()
        .map(|row| row.try_get::<String>("", "detail").unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}
