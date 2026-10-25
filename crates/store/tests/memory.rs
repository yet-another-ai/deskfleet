use deskfleet_model::{DirectoryBinding, DirectoryBindings};
use deskfleet_store::LocalCatalog;

#[tokio::test]
async fn memory_catalogs_initialize_independent_identities_and_records() {
    let first = LocalCatalog::open_in_memory("first-host").await.unwrap();
    let second = LocalCatalog::open_in_memory("second-host").await.unwrap();
    let first_identity = first.agent_identity().await.unwrap();
    let second_identity = second.agent_identity().await.unwrap();
    assert_ne!(first_identity.origin_id, second_identity.origin_id);
    assert_eq!(first.snapshot().await.unwrap().machine_name, "first-host");
    assert_eq!(second.snapshot().await.unwrap().machine_name, "second-host");

    let directories = DirectoryBindings::new(vec![DirectoryBinding {
        path: "/workspace".into(),
    }])
    .unwrap();
    let first_workspace = first
        .create_workspace("first workspace", directories.clone())
        .await
        .unwrap();
    assert!(second.snapshot().await.unwrap().workspaces.is_empty());
    let second_workspace = second
        .create_workspace("second workspace", directories)
        .await
        .unwrap();
    assert_eq!(
        first.snapshot().await.unwrap().workspaces,
        vec![first_workspace]
    );

    first.close().await.unwrap();
    assert_eq!(
        second.snapshot().await.unwrap().workspaces,
        vec![second_workspace]
    );
    assert_eq!(second.agent_identity().await.unwrap(), second_identity);
    assert!(second.agent_list().await.unwrap().is_empty());
    assert!(second.agent_allocate_id().await.unwrap() > 0);
    second.close().await.unwrap();
}
