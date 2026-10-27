use deskfleet_migration::{Migrator, MigratorTrait, SchemaManager};
use deskfleet_model::{DirectoryBinding, DirectoryBindings, DirectoryBindingsError, Machine};
use deskfleet_store::{
    Catalog, StoreError, connect,
    entities::{workspace, workspace_session, worktree, worktree_directory},
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, Set,
};

fn directories(paths: &[&str]) -> DirectoryBindings {
    DirectoryBindings::new(
        paths
            .iter()
            .map(|path| DirectoryBinding {
                path: (*path).to_owned(),
            })
            .collect(),
    )
    .unwrap()
}

async fn fixture() -> (Catalog, Machine) {
    let catalog = Catalog::new(connect("sqlite::memory:").await.unwrap());
    let team = catalog.create_team("developers").await.unwrap();
    let machine = catalog.create_machine(team.id, "host").await.unwrap();
    (catalog, machine)
}

#[tokio::test]
async fn workspace_creation_always_includes_one_main_with_ordered_actual_directories() {
    let (catalog, machine) = fixture().await;
    let workspace = catalog
        .create_workspace(
            machine.id,
            "storefront",
            directories(&[r"C:\code\web", "/services/api"]),
        )
        .await
        .unwrap();
    assert!(workspace.workspace.id.as_i64() > 0);
    assert_eq!(workspace.worktrees.len(), 1);
    let main = &workspace.worktrees[0];
    assert_eq!(main.workspace_id, Some(workspace.workspace.id));
    assert!(main.session_id.is_none());
    assert_eq!(main.directories.default_directory().path, r"C:\code\web");
    assert_eq!(main.directories.as_slice()[1].path, "/services/api");
    assert_eq!(
        catalog.workspace(workspace.workspace.id).await.unwrap(),
        Some(workspace.clone())
    );
    let sibling = catalog
        .create_workspace(machine.id, "storefront", directories(&["/notes"]))
        .await
        .unwrap();
    assert!(sibling.workspace.id > workspace.workspace.id);
    let other = catalog
        .create_machine(machine.team_id, "another host")
        .await
        .unwrap();
    let other_workspace = catalog
        .create_workspace(other.id, "storefront", directories(&["/other"]))
        .await
        .unwrap();
    assert_eq!(
        catalog.workspaces(machine.id).await.unwrap(),
        vec![workspace, sibling]
    );
    assert_eq!(
        catalog.workspaces(other.id).await.unwrap(),
        vec![other_workspace]
    );
}

#[tokio::test]
async fn session_lifetime_owns_copies_and_workspace_edits_only_change_main() {
    let (catalog, machine) = fixture().await;
    let workspace = catalog
        .create_workspace(machine.id, "workspace", directories(&["/checkout", "/api"]))
        .await
        .unwrap();
    let id = workspace.workspace.id;
    let main_id = workspace.worktrees[0].id;
    let session = catalog
        .create_workspace_session(machine.id, id)
        .await
        .unwrap();
    assert_eq!(
        catalog
            .workspace(id)
            .await
            .unwrap()
            .unwrap()
            .worktrees
            .len(),
        1
    );
    let session_directories = directories(&["/managed/session/web", "/managed/session/api"]);
    let owned = catalog
        .attach_session_worktree(machine.id, session.id, session_directories.clone())
        .await
        .unwrap();
    assert_eq!(owned.session_id, Some(session.id));
    assert!(
        catalog
            .attach_session_worktree(machine.id, session.id, session_directories)
            .await
            .is_err()
    );
    assert!(matches!(
        catalog.delete_workspace(machine.id, id).await,
        Err(StoreError::WorkspaceHasSessions { .. })
    ));
    let updated = catalog
        .update_workspace(
            machine.id,
            id,
            "renamed",
            directories(&["/new-api", "/new-web"]),
        )
        .await
        .unwrap();
    assert_eq!(updated.worktrees.len(), 2);
    assert_eq!(updated.worktrees[0].id, main_id);
    assert_eq!(
        updated.worktrees[0].directories.default_directory().path,
        "/new-api"
    );
    assert_eq!(updated.worktrees[1], owned);
    catalog
        .delete_workspace_session(machine.id, session.id)
        .await
        .unwrap();
    let remaining = catalog.workspace(id).await.unwrap().unwrap();
    assert_eq!(remaining.worktrees, vec![updated.worktrees[0].clone()]);
    assert_eq!(
        worktree_directory::Entity::find()
            .filter(worktree_directory::Column::WorktreeId.eq(owned.id.as_i64()))
            .count(catalog.database())
            .await
            .unwrap(),
        0
    );
    catalog.delete_workspace(machine.id, id).await.unwrap();
    assert!(catalog.workspace(id).await.unwrap().is_none());
    assert_eq!(
        worktree::Entity::find()
            .count(catalog.database())
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        worktree_directory::Entity::find()
            .count(catalog.database())
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn schema_rejects_second_main_cross_workspace_session_and_orphan_directories() {
    let (catalog, machine) = fixture().await;
    let first = catalog
        .create_workspace(machine.id, "first", directories(&["/first"]))
        .await
        .unwrap();
    let second = catalog
        .create_workspace(machine.id, "second", directories(&["/second"]))
        .await
        .unwrap();
    let session = catalog
        .create_workspace_session(machine.id, first.workspace.id)
        .await
        .unwrap();
    assert!(
        worktree::ActiveModel {
            workspace_id: Set(Some(first.workspace.id.as_i64())),
            session_id: Set(None),
            ..Default::default()
        }
        .insert(catalog.database())
        .await
        .is_err()
    );
    // A Session owns at most one worktree; workspace matching is enforced by attach.
    let attached = catalog
        .attach_session_worktree(machine.id, session.id, directories(&["/session"]))
        .await
        .unwrap();
    assert_eq!(attached.workspace_id, Some(first.workspace.id));
    assert!(
        worktree::ActiveModel {
            workspace_id: Set(Some(second.workspace.id.as_i64())),
            session_id: Set(Some(session.id.as_i64())),
            ..Default::default()
        }
        .insert(catalog.database())
        .await
        .is_err()
    );
    assert!(
        worktree_directory::ActiveModel {
            worktree_id: Set(i64::MAX),
            position: Set(0),
            path: Set("/orphan".into()),
        }
        .insert(catalog.database())
        .await
        .is_err()
    );
    assert!(
        worktree_directory::ActiveModel {
            worktree_id: Set(first.worktrees[0].id.as_i64()),
            position: Set(-1),
            path: Set("/negative".into()),
        }
        .insert(catalog.database())
        .await
        .is_err()
    );
    // The restriction is present in the database as well as the store method.
    assert!(
        workspace::Entity::delete_by_id(first.workspace.id.as_i64())
            .exec(catalog.database())
            .await
            .is_err()
    );
    let workspace_id = first.workspace.id;
    let mut expected = first;
    expected.worktrees.push(attached);
    assert_eq!(
        catalog.workspace(workspace_id).await.unwrap(),
        Some(expected)
    );
}

#[tokio::test]
async fn failed_directory_writes_roll_back_workspace_and_session_worktrees() {
    let (catalog, machine) = fixture().await;
    let original = catalog
        .create_workspace(machine.id, "original", directories(&["/original"]))
        .await
        .unwrap();
    catalog.database().execute_unprepared(
        "CREATE TRIGGER reject_directory BEFORE INSERT ON worktree_directories WHEN NEW.path = '/reject' BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    ).await.unwrap();
    let rejected = directories(&["/valid", "/reject"]);
    assert!(
        catalog
            .create_workspace(machine.id, "incomplete", rejected.clone())
            .await
            .is_err()
    );
    assert!(
        catalog
            .update_workspace(
                machine.id,
                original.workspace.id,
                "not saved",
                rejected.clone()
            )
            .await
            .is_err()
    );
    assert_eq!(
        catalog.workspaces(machine.id).await.unwrap(),
        vec![original.clone()]
    );
    let session = catalog
        .create_workspace_session(machine.id, original.workspace.id)
        .await
        .unwrap();
    assert!(
        catalog
            .attach_session_worktree(machine.id, session.id, rejected)
            .await
            .is_err()
    );
    assert_eq!(
        catalog.workspace(original.workspace.id).await.unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        workspace_session::Entity::find()
            .count(catalog.database())
            .await
            .unwrap(),
        1
    );
    catalog
        .delete_workspace_session(machine.id, session.id)
        .await
        .unwrap();
}

#[tokio::test]
async fn invalid_persisted_main_context_is_reported_and_migrations_round_trip() {
    let (catalog, machine) = fixture().await;
    let value = catalog
        .create_workspace(machine.id, "workspace", directories(&["/checkout"]))
        .await
        .unwrap();
    worktree_directory::Entity::delete_many()
        .filter(worktree_directory::Column::WorktreeId.eq(value.worktrees[0].id.as_i64()))
        .exec(catalog.database())
        .await
        .unwrap();
    assert!(matches!(
        catalog.workspace(value.workspace.id).await,
        Err(StoreError::DirectoryBindings(DirectoryBindingsError::Empty))
    ));
    worktree::Entity::delete_by_id(value.worktrees[0].id.as_i64())
        .exec(catalog.database())
        .await
        .unwrap();
    assert!(matches!(
        catalog.workspace(value.workspace.id).await,
        Err(StoreError::MissingMainWorktree { .. })
    ));
    Migrator::down(catalog.database(), None).await.unwrap();
    let schema = SchemaManager::new(catalog.database());
    for table in [
        "worktree_directories",
        "worktrees",
        "workspace_sessions",
        "workspaces",
        "machines",
        "teams",
    ] {
        assert!(!schema.has_table(table).await.unwrap());
    }
    Migrator::up(catalog.database(), None).await.unwrap();
    let team = catalog.create_team("restored").await.unwrap();
    let machine = catalog.create_machine(team.id, "restored").await.unwrap();
    let restored = catalog
        .create_workspace(machine.id, "restored", directories(&["/restored"]))
        .await
        .unwrap();
    assert_eq!(restored.worktrees.len(), 1);
}
