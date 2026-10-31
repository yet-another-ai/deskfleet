//! Search behavior against real PostgreSQL, including streaming index cost.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use serde_json::{Value, json};

struct Fixture {
    store: ControlStore,
    database: DatabaseConnection,
    schema: String,
    user: String,
    team: String,
    machine: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let database = Database::connect(&url).await.unwrap();
        let schema = format!("search_{}", uuid::Uuid::new_v4().simple());
        database
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let user = store
            .verified_user("owner@fixture.test", "Owner")
            .await
            .unwrap();
        let team = store.create_team(&user.id, "Team").await.unwrap();
        let machine = store
            .enroll(
                &user.id,
                &team.id,
                "Offline machine",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap()
            .0
            .id;
        let fixture = Self {
            store,
            database,
            schema,
            user: user.id,
            team: team.id,
            machine,
        };
        fixture.catalog(&["1", "2", "3"]).await;
        fixture
    }

    async fn catalog(&self, ids: &[&str]) {
        self.store.save_catalog(&self.machine,json!({"machineId":"1","workspaces":[{"id":"1","name":"Workspace"}],"sessionIds":ids}),json!({})).await.unwrap();
    }

    async fn search(&self, q: &str) -> Value {
        self.store
            .search(&self.user, &self.team, q, "all", None, 20)
            .await
            .unwrap()
    }

    async fn sql(&self, query: &str) -> Value {
        self.store
            .database()
            .query_one_raw(Statement::from_string(DbBackend::Postgres, query))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "value")
            .unwrap()
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.database
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.database.close().await.unwrap();
    }
}

fn snapshot(id: &str, seq: i64, running: bool) -> Value {
    json!({"session":{"id":id,"workspaceId":"1","title":"Chat title","archiveState":"active","lifecycle":"ready","lastEventSeq":seq.to_string(),"updatedAt":"2026-10-31T00:00:00.000Z"},"runs":[],"inputs":[],"turns":[{"id":"turn-1","state":if running { "running" } else { "completed" }}],"permissions":[],"elicitations":[]})
}

fn event(seq: i64, text: &str) -> Value {
    json!({"sessionId":"1","seq":seq.to_string(),"kind":"acp","runGeneration":1,"turnId":"turn-1","payload":{"sessionId":"provider","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
}

fn terminal(seq: i64, state: &str) -> Value {
    json!({"sessionId":"1","seq":seq.to_string(),"kind":"turn","payload":{"id":"turn-1","state":state}})
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn streaming_is_unindexed_until_contiguous_completion_and_replays_do_not_rewrite() {
    let f = Fixture::new().await;
    for seq in 1..=8 {
        f.store
            .sync_history(
                &f.machine,
                "1",
                snapshot("1", seq, true),
                vec![event(seq, "stream中文_")],
                vec![],
            )
            .await
            .unwrap();
    }
    assert_eq!(f.search("stream").await["results"], json!([]));
    assert_eq!(f.sql("SELECT jsonb_build_object('documents',(SELECT count(*) FROM cp_search_documents),'entries',(SELECT count(*) FROM cp_search_entries),'cursor',(SELECT indexed_seq FROM cp_search_progress WHERE session_id='1')) AS value").await,json!({"documents":1,"entries":0,"cursor":0}));

    // A snapshot can lead the event watermark. Its terminal state alone is insufficient.
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", 10, false),
            vec![event(9, "tail")],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(f.search("stream").await["results"], json!([]));
    f.store
        .sync_history_batch(
            &f.machine,
            "1",
            None,
            Some("10".into()),
            vec![terminal(10, "completed")],
            vec![],
        )
        .await
        .unwrap();
    let result = f.search("中文_").await;
    assert_eq!(result["results"].as_array().unwrap().len(), 1);
    assert_eq!(result["results"][0]["entryId"], "message-1");
    assert_eq!(result["results"][0]["workspaceName"], "Workspace");
    let before = f.sql("SELECT jsonb_agg(jsonb_build_array(entry_id,block_no,xmin::text) ORDER BY entry_id,block_no) AS value FROM cp_search_documents").await;
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", 10, false),
            vec![event(9, "tail"), terminal(10, "completed")],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(before,f.sql("SELECT jsonb_agg(jsonb_build_array(entry_id,block_no,xmin::text) ORDER BY entry_id,block_no) AS value FROM cp_search_documents").await);

    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", 11, true),
            vec![event(11, "later")],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(before,f.sql("SELECT jsonb_agg(jsonb_build_array(entry_id,block_no,xmin::text) ORDER BY entry_id,block_no) AS value FROM cp_search_documents").await);
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", 12, false),
            vec![terminal(12, "interrupted")],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        f.search("later").await["results"][0]["entryId"],
        "message-11"
    );
    assert_eq!(
        f.sql("SELECT to_jsonb(indexed_seq) AS value FROM cp_search_progress WHERE session_id='1'")
            .await,
        json!(12)
    );
    assert_eq!(before,f.sql("SELECT jsonb_agg(jsonb_build_array(entry_id,block_no,xmin::text) ORDER BY entry_id,block_no) AS value FROM cp_search_documents WHERE entry_id<>'message-11'").await);
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn unicode_blocks_and_message_ids_preserve_cross_chunk_matches_and_anchors() {
    let f = Fixture::new().await;
    let mut first = event(1, &"中".repeat(4000));
    first["payload"]["update"]["messageId"] = "shared".into();
    let tool = json!({"sessionId":"1","seq":"2","kind":"acp","runGeneration":1,"payload":{"update":{"sessionUpdate":"tool_call","toolCallId":"tool"}}});
    let mut second = event(3, &format!("{} use_%\\path 中文检索", "文".repeat(300)));
    second["payload"]["update"]["messageId"] = "shared".into();
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", 4, false),
            vec![first, tool, second, terminal(4, "cancelled")],
            vec![],
        )
        .await
        .unwrap();
    let crossing = format!("{}{}", "中".repeat(128), "文".repeat(128));
    assert_eq!(
        f.search(&crossing).await["results"][0]["entryId"],
        "message-1"
    );
    assert_eq!(
        f.search("USE_%\\PATH").await["results"][0]["entryId"],
        "message-1"
    );
    assert_eq!(
        f.search("中文检索").await["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.sql("SELECT to_jsonb(max(char_length(content))) AS value FROM cp_search_documents")
            .await,
        json!(4096)
    );
    let old = f.sql("SELECT to_jsonb(xmin::text) AS value FROM cp_search_documents WHERE entry_id='message-1' AND block_no=0").await;
    // Explicit message identities can recur in a later turn; only their bounded tail changes.
    let mut next = event(5, " later-message-content");
    next["payload"]["update"]["messageId"] = "shared".into();
    next["turnId"] = "turn-2".into();
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", 6, false),
            vec![next, terminal(6, "completed")],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        f.search("later-message-content").await["results"][0]["entryId"],
        "message-1"
    );
    assert_eq!(old,f.sql("SELECT to_jsonb(xmin::text) AS value FROM cp_search_documents WHERE entry_id='message-1' AND block_no=0").await);
    assert!(matches!(
        f.store
            .search(&f.user, &f.team, &"文".repeat(257), "all", None, 10)
            .await,
        Err(Error::Invalid(_))
    ));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn idle_fork_boundary_survives_a_newer_running_snapshot_and_input_states_are_respected() {
    let f = Fixture::new().await;
    let mut inherited = event(1, "inherited fork history");
    inherited.as_object_mut().unwrap().remove("turnId");
    let mut idle = snapshot("1", 2, false);
    idle["turns"] = json!([]);
    f.store
        .sync_history(&f.machine, "1", idle, vec![inherited], vec![])
        .await
        .unwrap();
    assert_eq!(f.search("inherited").await["results"], json!([]));
    let input = json!({"sessionId":"1","seq":"2","kind":"input","payload":{"id":"input-1","state":"delivered","content":[{"type":"text","text":"user prompt searchable"}]}});
    f.store
        .sync_history(&f.machine, "1", snapshot("1", 4, true), vec![input], vec![])
        .await
        .unwrap();
    assert_eq!(
        f.search("inherited").await["results"][0]["entryId"],
        "message-1"
    );
    assert_eq!(
        f.search("user prompt").await["results"][0]["entryId"],
        "input-input-1"
    );
    let withdrawn = json!({"sessionId":"1","seq":"3","kind":"input","payload":{"id":"withdrawn","state":"withdrawn","content":[{"type":"text","text":"removed backlog"}]}});
    f.store
        .sync_history_batch(
            &f.machine,
            "1",
            None,
            Some("4".into()),
            vec![withdrawn, terminal(4, "failed")],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(f.search("removed backlog").await["results"], json!([]));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn authorization_current_inventory_schedules_and_keyset_pages_filter_before_pagination() {
    let f = Fixture::new().await;
    for id in ["1", "2", "3"] {
        let mut snapshot = snapshot(id, 0, false);
        snapshot["session"]["title"] = format!("needle {id}").into();
        if id == "1" {
            snapshot["session"]["archiveState"] = "archived".into();
        }
        f.store
            .sync_history(&f.machine, id, snapshot, vec![], vec![])
            .await
            .unwrap();
    }
    f.catalog(&["1", "3"]).await;
    let task = json!({"id":"task","title":"needle task","prompt":"schedule body","workspaceId":"1","enabled":false,"target":{"kind":"existing","sessionId":"3"},"trigger":{"kind":"manual"},"createdAt":"2026-10-31T00:00:00.000Z","updatedAt":"2026-10-31T00:00:00.000Z","runs":[],"actor":{"secret":"must not persist"}});
    f.store
        .sync_schedules(&f.machine, json!([task]))
        .await
        .unwrap();
    assert!(
        f.store.schedule_snapshot(&f.machine).await.unwrap()["tasks"][0]
            .get("actor")
            .is_none()
    );
    let first = f
        .store
        .search(&f.user, &f.team, "needle", "all", None, 1)
        .await
        .unwrap();
    assert_eq!(first["results"][0]["resourceId"], "3");
    let second = f
        .store
        .search(
            &f.user,
            &f.team,
            "needle",
            "all",
            first["nextCursor"].as_str(),
            1,
        )
        .await
        .unwrap();
    assert_eq!(second["results"][0]["resourceId"], "task");
    assert!(second.get("nextCursor").is_none());
    assert!(second["results"][0].get("entryId").is_none());
    let outsider = f
        .store
        .verified_user("outsider@fixture.test", "Outsider")
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .search(&outsider.id, &f.team, "needle", "all", None, 10)
            .await,
        Err(Error::Forbidden)
    ));
    f.store.sync_schedules(&f.machine, json!([])).await.unwrap();
    assert_eq!(f.search("schedule body").await["results"], json!([]));
    f.store
        .database()
        .execute_unprepared("UPDATE cp_machines SET revoked=true")
        .await
        .unwrap();
    assert_eq!(f.search("needle").await["results"], json!([]));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn excluded_anonymous_thoughts_do_not_create_per_chunk_projection_rows() {
    let f = Fixture::new().await;
    let mut first = event(1, "first anonymous answer");
    first["payload"]["update"]["messageId"] = "".into();
    // Empty direct IDs also take precedence over metadata IDs, as in the UI.
    first["payload"]["update"]["_meta"] = json!({"deskfleet":{"messageId":"ignored"}});
    let mut events = vec![first];
    for seq in 2..=401 {
        let mut thought = event(seq, "excluded internal thought");
        thought["payload"]["update"]["sessionUpdate"] = "agent_thought_chunk".into();
        events.push(thought);
    }
    let mut last = event(402, "second anonymous answer");
    last["payload"]["update"]["messageId"] = "".into();
    events.extend([last, terminal(403, "completed")]);
    f.store
        .sync_history(&f.machine, "1", snapshot("1", 403, false), events, vec![])
        .await
        .unwrap();
    assert_eq!(
        f.sql("SELECT to_jsonb(count(*)) AS value FROM cp_search_entries")
            .await,
        json!(2)
    );
    assert_eq!(f.search("excluded internal").await["results"], json!([]));
    assert_eq!(
        f.search("second anonymous").await["results"][0]["entryId"],
        "message-402"
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn migration_backfills_existing_stable_history_once_and_keeps_streaming_body_pending() {
    let f = Fixture::new().await;
    let mut inherited = event(1, "existing inherited transcript");
    inherited.as_object_mut().unwrap().remove("turnId");
    let mut idle = snapshot("1", 1, false);
    idle["turns"] = json!([]);
    f.store
        .sync_history(&f.machine, "1", idle, vec![inherited], vec![])
        .await
        .unwrap();
    let mut streaming = event(1, "unfinished streaming reply");
    streaming["sessionId"] = "2".into();
    f.store
        .sync_history(
            &f.machine,
            "2",
            snapshot("2", 1, true),
            vec![streaming],
            vec![],
        )
        .await
        .unwrap();

    // Recreate only this isolated fixture's migration-19 read models.
    f.store
        .database()
        .execute_unprepared(include_str!("../src/search/schema_down.sql"))
        .await
        .unwrap();
    f.store
        .database()
        .execute_unprepared("DELETE FROM cp_migrations WHERE version=19")
        .await
        .unwrap();
    deskfleet_control_store::schema::migrate(f.store.database())
        .await
        .unwrap();
    assert_eq!(
        f.search("existing inherited").await["results"][0]["entryId"],
        "message-1"
    );
    assert_eq!(f.search("unfinished streaming").await["results"], json!([]));
    let before = f.sql("SELECT jsonb_agg(jsonb_build_array(resource_id,entry_id,xmin::text) ORDER BY resource_id,entry_id) AS value FROM cp_search_documents").await;
    deskfleet_control_store::schema::migrate(f.store.database())
        .await
        .unwrap();
    assert_eq!(before,f.sql("SELECT jsonb_agg(jsonb_build_array(resource_id,entry_id,xmin::text) ORDER BY resource_id,entry_id) AS value FROM cp_search_documents").await);
    let mut done = terminal(2, "interrupted");
    done["sessionId"] = "2".into();
    f.store
        .sync_history(&f.machine, "2", snapshot("2", 2, false), vec![done], vec![])
        .await
        .unwrap();
    assert_eq!(
        f.search("unfinished streaming").await["results"][0]["resourceId"],
        "2"
    );
    f.close().await;
}
