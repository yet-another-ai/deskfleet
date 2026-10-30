use super::*;

#[tokio::test]
async fn shared_completion_and_read_watermarks_survive_reopening_the_catalog() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let created = create(&local).await;
    assert_eq!(created.session.last_completed_seq, None);
    assert_eq!(created.session.last_read_seq, None);

    let mut completed = created.session.clone();
    completed.last_completed_seq = Some(1.into());
    let mut commit = transaction(&created.session);
    commit.session = Some(completed.clone());
    commit.events = vec![event(completed.id, EventKind::Session, &completed)];
    let completed = local.agent_commit(commit).await.unwrap().session.unwrap();
    let mut read = completed.clone();
    read.last_read_seq = Some(completed.last_event_seq);
    let mut commit = transaction(&completed);
    commit.session = Some(read.clone());
    commit.events = vec![event(read.id, EventKind::Session, &read)];
    let committed = local.agent_commit(commit).await.unwrap();
    assert_eq!(committed.events[0].event.payload["lastReadSeq"], "1");
    drop(local);

    let reopened = LocalCatalog::open(&file.0, "host").await.unwrap();
    let session = reopened.agent_session(read.id).await.unwrap().unwrap();
    assert_eq!(session.last_completed_seq, Some(1.into()));
    assert_eq!(session.last_read_seq, Some(1.into()));
    assert_eq!(session.last_event_seq.as_i64(), 2);
}
