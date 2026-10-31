use std::{future::poll_fn, task::Poll};

use deskfleet_model::DirectoryBinding;
use sea_orm::ConnectionTrait;

use super::*;

#[tokio::test]
async fn snapshot_keeps_workspaces_and_machine_sessions_in_one_transaction() {
    let local = LocalCatalog::open_in_memory("snapshot").await.unwrap();
    let workspace = local
        .create_workspace(
            "before",
            DirectoryBindings::new(vec![DirectoryBinding {
                path: "/before".into(),
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    let database = local.catalog.database();
    // Hold the only connection so the read and write can be queued in order.
    let gate = database.begin().await.unwrap();
    let snapshot = local.snapshot();
    let write = async {
        let transaction = database.begin().await.unwrap();
        transaction
            .execute_unprepared(&format!(
                "DELETE FROM workspaces WHERE id = {}; \
                 INSERT INTO workspace_sessions (machine_id) VALUES ({}); \
                 INSERT INTO worktrees (session_id) VALUES (last_insert_rowid()); \
                 INSERT INTO worktree_directories (worktree_id, position, path) \
                 VALUES (last_insert_rowid(), 0, '/after')",
                workspace.workspace.id.as_i64(),
                local.machine.id.as_i64(),
            ))
            .await
            .unwrap();
        transaction.commit().await.unwrap();
    };
    let mut snapshot = std::pin::pin!(snapshot);
    let mut write = std::pin::pin!(write);
    poll_fn(|cx| {
        assert!(snapshot.as_mut().poll(cx).is_pending());
        assert!(write.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    gate.rollback().await.unwrap();
    let (snapshot, ()) = tokio::join!(snapshot, write);
    let snapshot = snapshot.unwrap();
    assert_eq!(snapshot.workspaces, vec![workspace.clone()]);
    assert!(snapshot.sessions.is_empty());
    let after = local.snapshot().await.unwrap();
    assert!(after.workspaces.is_empty());
    assert_eq!(after.sessions.len(), 1);
    assert_eq!(
        after.sessions[0].directories.default_directory().path,
        "/after"
    );
    local.close().await.unwrap();
}
