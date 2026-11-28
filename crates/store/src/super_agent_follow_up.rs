use crate::{
    LocalCatalog, StoreError,
    entities::{
        super_agent_follow_up_action as action, super_agent_follow_up_auth as auth,
        super_agent_follow_up_run as run, super_agent_follow_up_source as source,
    },
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    Set, sea_query::Expr,
};

#[derive(Clone, Debug)]
pub struct FollowUpSourceWrite {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub revision: i32,
    pub state_json: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct FollowUpRunQuery {
    pub user_id: String,
    pub workspace_id: Option<String>,
    pub source_kind: Option<String>,
    pub source_id: Option<String>,
    pub before_created_at: Option<String>,
    pub before_id: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug)]
pub struct FollowUpRunWrite {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub run_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub record_json: String,
}

#[derive(Clone, Debug)]
pub struct FollowUpActionWrite {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub action_key: String,
    pub status: String,
    pub auth_version: i32,
    pub created_at: String,
    pub updated_at: String,
    pub record_json: String,
}

impl LocalCatalog {
    pub async fn super_agent_follow_up_auths(&self) -> Result<Vec<auth::Model>, StoreError> {
        Ok(auth::Entity::find().all(self.catalog.database()).await?)
    }

    pub async fn save_super_agent_follow_up_auth(
        &self,
        user_id: String,
        revision: i32,
        auth_version: i32,
        state_json: String,
    ) -> Result<(), StoreError> {
        let db = self.catalog.database();
        let next = revision
            .checked_add(1)
            .ok_or(StoreError::InvalidAgent("follow-up auth revision overflow"))?;
        if revision == 0 {
            auth::ActiveModel {
                user_id: Set(user_id),
                revision: Set(next),
                auth_version: Set(auth_version),
                state_json: Set(state_json),
            }
            .insert(db)
            .await?;
        } else {
            let changed = auth::Entity::update_many()
                .col_expr(auth::Column::Revision, Expr::value(next))
                .col_expr(auth::Column::AuthVersion, Expr::value(auth_version))
                .col_expr(auth::Column::StateJson, Expr::value(state_json))
                .filter(auth::Column::UserId.eq(user_id))
                .filter(auth::Column::Revision.eq(revision))
                .exec(db)
                .await?;
            if changed.rows_affected != 1 {
                return Err(StoreError::InvalidAgent(
                    "follow-up auth changed during write",
                ));
            }
        }
        Ok(())
    }

    pub async fn super_agent_follow_up_sources(
        &self,
        user_id: Option<String>,
        workspace_id: Option<String>,
    ) -> Result<Vec<source::Model>, StoreError> {
        let mut query = source::Entity::find();
        if let Some(uid) = user_id {
            query = query.filter(source::Column::UserId.eq(uid));
        }
        if let Some(wid) = workspace_id {
            query = query.filter(source::Column::WorkspaceId.eq(wid));
        }
        Ok(query
            .order_by_desc(source::Column::UpdatedAt)
            .order_by_asc(source::Column::Id)
            .all(self.catalog.database())
            .await?)
    }

    pub async fn save_super_agent_follow_up_source(
        &self,
        record: FollowUpSourceWrite,
    ) -> Result<source::Model, StoreError> {
        let db = self.catalog.database();
        let next = record
            .revision
            .checked_add(1)
            .ok_or(StoreError::InvalidAgent(
                "follow-up source revision overflow",
            ))?;
        if record.revision == 0 {
            let model = source::ActiveModel {
                id: Set(record.id.clone()),
                user_id: Set(record.user_id.clone()),
                workspace_id: Set(record.workspace_id.clone()),
                source_kind: Set(record.source_kind.clone()),
                source_id: Set(record.source_id.clone()),
                revision: Set(next),
                state_json: Set(record.state_json.clone()),
                updated_at: Set(record.updated_at.clone()),
            }
            .insert(db)
            .await?;
            return Ok(model);
        }
        let changed = source::Entity::update_many()
            .col_expr(source::Column::Revision, Expr::value(next))
            .col_expr(
                source::Column::StateJson,
                Expr::value(record.state_json.clone()),
            )
            .col_expr(
                source::Column::UpdatedAt,
                Expr::value(record.updated_at.clone()),
            )
            .filter(source::Column::UserId.eq(record.user_id.clone()))
            .filter(source::Column::WorkspaceId.eq(record.workspace_id.clone()))
            .filter(source::Column::SourceKind.eq(record.source_kind.clone()))
            .filter(source::Column::SourceId.eq(record.source_id.clone()))
            .filter(source::Column::Revision.eq(record.revision))
            .exec(db)
            .await?;
        if changed.rows_affected != 1 {
            return Err(StoreError::InvalidAgent(
                "follow-up source changed during write",
            ));
        }
        Ok(source::Model {
            id: record.id,
            user_id: record.user_id,
            workspace_id: record.workspace_id,
            source_kind: record.source_kind,
            source_id: record.source_id,
            revision: next,
            state_json: record.state_json,
            updated_at: record.updated_at,
        })
    }

    pub async fn super_agent_follow_up_runs(
        &self,
        filter: FollowUpRunQuery,
    ) -> Result<Vec<run::Model>, StoreError> {
        let bounded = u64::from(filter.limit.clamp(1, 201));
        let mut query = run::Entity::find().filter(run::Column::UserId.eq(filter.user_id));
        if let Some(wid) = filter.workspace_id {
            query = query.filter(run::Column::WorkspaceId.eq(wid));
        }
        if let Some(kind) = filter.source_kind {
            query = query.filter(run::Column::SourceKind.eq(kind));
        }
        if let Some(sid) = filter.source_id {
            query = query.filter(run::Column::SourceId.eq(sid));
        }
        if let (Some(created_at), Some(id)) = (filter.before_created_at, filter.before_id) {
            query = query.filter(
                Condition::any()
                    .add(run::Column::CreatedAt.lt(created_at.clone()))
                    .add(
                        Condition::all()
                            .add(run::Column::CreatedAt.eq(created_at))
                            .add(run::Column::Id.lt(id)),
                    ),
            );
        }
        Ok(query
            .order_by_desc(run::Column::CreatedAt)
            .order_by_desc(run::Column::Id)
            .limit(bounded)
            .all(self.catalog.database())
            .await?)
    }
}

fn run_status_rank(status: &str) -> Option<u8> {
    match status {
        "claimed" => Some(0),
        "running" | "attention" => Some(1),
        "completed" | "failed" | "interrupted" | "skipped" | "restricted" => Some(2),
        _ => None,
    }
}

/// Storage-level monotonic protection: never let a late/out-of-order `claimed`/`running` write
/// downgrade a terminal or already-delivered follow-up run record in SQLite.
fn merge_run_record_json_monotonic(
    existing_json: &str,
    incoming_json: &str,
    existing_id: &str,
) -> (String, Option<String>) {
    let (Ok(serde_json::Value::Object(mut existing)), Ok(serde_json::Value::Object(mut incoming))) = (
        serde_json::from_str::<serde_json::Value>(existing_json),
        serde_json::from_str::<serde_json::Value>(incoming_json),
    ) else {
        return (incoming_json.to_string(), None);
    };
    let Some(existing_rank) = existing
        .get("status")
        .and_then(|v| v.as_str())
        .and_then(run_status_rank)
    else {
        return (incoming_json.to_string(), None);
    };
    let incoming_rank = incoming
        .get("status")
        .and_then(|v| v.as_str())
        .and_then(run_status_rank)
        .unwrap_or(0);
    let existing_delivered = existing
        .get("delivered")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let incoming_delivered = incoming
        .get("delivered")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if incoming_rank < existing_rank
        || (incoming_rank == existing_rank && existing_delivered && !incoming_delivered)
    {
        for key in ["sessionId", "inputId", "turnId"] {
            if (!existing.contains_key(key) || existing.get(key).is_some_and(|v| v.is_null()))
                && let Some(val) = incoming.get(key).filter(|v| !v.is_null()).cloned()
            {
                existing.insert(key.to_string(), val);
            }
        }
        let existing_updated = existing
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let incoming_updated = incoming
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let chosen_updated = match (&existing_updated, &incoming_updated) {
            (Some(a), Some(b)) => Some(if a >= b { a.clone() } else { b.clone() }),
            (Some(a), None) => Some(a.clone()),
            (None, Some(b)) => Some(b.clone()),
            (None, None) => None,
        };
        if let Some(ref ts) = chosen_updated {
            existing.insert(
                "updatedAt".to_string(),
                serde_json::Value::String(ts.clone()),
            );
        }
        existing.insert(
            "id".to_string(),
            serde_json::Value::String(existing_id.to_string()),
        );
        let merged = serde_json::to_string(&serde_json::Value::Object(existing))
            .unwrap_or_else(|_| existing_json.to_string());
        return (merged, chosen_updated);
    }

    incoming.insert(
        "id".to_string(),
        serde_json::Value::String(existing_id.to_string()),
    );
    if let Some(created) = existing.get("createdAt").cloned() {
        incoming.insert("createdAt".to_string(), created);
    }
    for key in [
        "sessionId",
        "inputId",
        "turnId",
        "deliveredMessageId",
        "ticketId",
        "evidenceRefs",
    ] {
        if (!incoming.contains_key(key) || incoming.get(key).is_some_and(|v| v.is_null()))
            && let Some(val) = existing.get(key).filter(|v| !v.is_null()).cloned()
        {
            incoming.insert(key.to_string(), val);
        }
    }
    if existing_delivered {
        incoming.insert("delivered".to_string(), serde_json::Value::Bool(true));
    }
    let updated = incoming
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let merged = serde_json::to_string(&serde_json::Value::Object(incoming))
        .unwrap_or_else(|_| incoming_json.to_string());
    (merged, updated)
}

impl LocalCatalog {
    pub async fn super_agent_follow_up_run(
        &self,
        user_id: String,
        workspace_id: String,
        source_kind: String,
        source_id: String,
        run_key: String,
    ) -> Result<Option<run::Model>, StoreError> {
        Ok(run::Entity::find()
            .filter(run::Column::UserId.eq(user_id))
            .filter(run::Column::WorkspaceId.eq(workspace_id))
            .filter(run::Column::SourceKind.eq(source_kind))
            .filter(run::Column::SourceId.eq(source_id))
            .filter(run::Column::RunKey.eq(run_key))
            .one(self.catalog.database())
            .await?)
    }

    pub async fn upsert_super_agent_follow_up_run(
        &self,
        record: FollowUpRunWrite,
    ) -> Result<run::Model, StoreError> {
        let db = self.catalog.database();
        let existing = run::Entity::find()
            .filter(run::Column::UserId.eq(record.user_id.clone()))
            .filter(run::Column::WorkspaceId.eq(record.workspace_id.clone()))
            .filter(run::Column::SourceKind.eq(record.source_kind.clone()))
            .filter(run::Column::SourceId.eq(record.source_id.clone()))
            .filter(run::Column::RunKey.eq(record.run_key.clone()))
            .one(db)
            .await?;
        if let Some(saved) = existing {
            let (merged_json, merged_updated) =
                merge_run_record_json_monotonic(&saved.record_json, &record.record_json, &saved.id);
            let next_updated = merged_updated.unwrap_or_else(|| {
                if saved.updated_at >= record.updated_at {
                    saved.updated_at.clone()
                } else {
                    record.updated_at.clone()
                }
            });
            let mut active: run::ActiveModel = saved.into();
            active.updated_at = Set(next_updated);
            active.record_json = Set(merged_json);
            return Ok(active.update(db).await?);
        }
        Ok(run::ActiveModel {
            id: Set(record.id),
            user_id: Set(record.user_id),
            workspace_id: Set(record.workspace_id),
            source_kind: Set(record.source_kind),
            source_id: Set(record.source_id),
            run_key: Set(record.run_key),
            created_at: Set(record.created_at),
            updated_at: Set(record.updated_at),
            record_json: Set(record.record_json),
        }
        .insert(db)
        .await?)
    }

    pub async fn super_agent_follow_up_actions(
        &self,
        user_id: String,
        status: Option<String>,
        limit: u32,
        before_created_at: Option<String>,
        before_id: Option<String>,
    ) -> Result<Vec<action::Model>, StoreError> {
        let bounded = u64::from(limit.clamp(1, 500));
        let mut query = action::Entity::find().filter(action::Column::UserId.eq(user_id));
        if let Some(s) = status {
            query = query.filter(action::Column::Status.eq(s));
        }
        if let (Some(created_at), Some(id)) = (before_created_at, before_id) {
            query = query.filter(
                Condition::any()
                    .add(action::Column::CreatedAt.lt(created_at.clone()))
                    .add(
                        Condition::all()
                            .add(action::Column::CreatedAt.eq(created_at))
                            .add(action::Column::Id.lt(id)),
                    ),
            );
        }
        Ok(query
            .order_by_desc(action::Column::CreatedAt)
            .order_by_desc(action::Column::Id)
            .limit(bounded)
            .all(self.catalog.database())
            .await?)
    }

    pub async fn upsert_super_agent_follow_up_action(
        &self,
        record: FollowUpActionWrite,
    ) -> Result<action::Model, StoreError> {
        let db = self.catalog.database();
        let existing = action::Entity::find()
            .filter(action::Column::UserId.eq(record.user_id.clone()))
            .filter(action::Column::ActionKey.eq(record.action_key.clone()))
            .one(db)
            .await?;
        if let Some(saved) = existing {
            let mut active: action::ActiveModel = saved.into();
            active.status = Set(record.status);
            active.auth_version = Set(record.auth_version);
            active.updated_at = Set(record.updated_at);
            active.record_json = Set(record.record_json);
            return Ok(active.update(db).await?);
        }
        Ok(action::ActiveModel {
            id: Set(record.id),
            user_id: Set(record.user_id),
            workspace_id: Set(record.workspace_id),
            source_kind: Set(record.source_kind),
            source_id: Set(record.source_id),
            action_key: Set(record.action_key),
            status: Set(record.status),
            auth_version: Set(record.auth_version),
            created_at: Set(record.created_at),
            updated_at: Set(record.updated_at),
            record_json: Set(record.record_json),
        }
        .insert(db)
        .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn follow_up_tables_enforce_cas_isolation_and_paginated_runs() {
        let catalog = LocalCatalog::open_in_memory("test-host").await.unwrap();

        catalog
            .save_super_agent_follow_up_auth("u1".into(), 0, 1, "{\"grants\":[]}".into())
            .await
            .unwrap();
        assert!(
            catalog
                .save_super_agent_follow_up_auth("u1".into(), 0, 2, "{}".into())
                .await
                .is_err()
        );
        catalog
            .save_super_agent_follow_up_auth("u1".into(), 1, 2, "{\"grants\":[\"mac\"]}".into())
            .await
            .unwrap();
        let auths = catalog.super_agent_follow_up_auths().await.unwrap();
        assert_eq!(auths.len(), 1);
        assert_eq!(auths[0].revision, 2);
        assert_eq!(auths[0].auth_version, 2);

        let src = catalog
            .save_super_agent_follow_up_source(FollowUpSourceWrite {
                id: "src-1".into(),
                user_id: "u1".into(),
                workspace_id: "ws-1".into(),
                source_kind: "schedule".into(),
                source_id: "sched-1".into(),
                revision: 0,
                state_json: "{\"enabled\":true}".into(),
                updated_at: "2026-11-23T00:00:00Z".into(),
            })
            .await
            .unwrap();
        assert_eq!(src.revision, 1);

        // User isolation
        assert!(
            catalog
                .super_agent_follow_up_sources(Some("u2".into()), None)
                .await
                .unwrap()
                .is_empty()
        );

        // Paginated run reads
        for i in 1..=3 {
            catalog
                .upsert_super_agent_follow_up_run(FollowUpRunWrite {
                    id: format!("run-{i}"),
                    user_id: "u1".into(),
                    workspace_id: "ws-1".into(),
                    source_kind: "schedule".into(),
                    source_id: "sched-1".into(),
                    run_key: format!("key-{i}"),
                    created_at: format!("2026-11-23T00:0{i}:00Z"),
                    updated_at: format!("2026-11-23T00:0{i}:00Z"),
                    record_json: format!("{{\"n\":{i}}}"),
                })
                .await
                .unwrap();
        }
        let page1 = catalog
            .super_agent_follow_up_runs(FollowUpRunQuery {
                user_id: "u1".into(),
                workspace_id: Some("ws-1".into()),
                source_kind: Some("schedule".into()),
                source_id: Some("sched-1".into()),
                before_created_at: None,
                before_id: None,
                limit: 2,
            })
            .await
            .unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0].id, "run-3");
        assert_eq!(page1[1].id, "run-2");

        let page2 = catalog
            .super_agent_follow_up_runs(FollowUpRunQuery {
                user_id: "u1".into(),
                workspace_id: Some("ws-1".into()),
                source_kind: Some("schedule".into()),
                source_id: Some("sched-1".into()),
                before_created_at: Some(page1[1].created_at.clone()),
                before_id: Some(page1[1].id.clone()),
                limit: 2,
            })
            .await
            .unwrap();
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].id, "run-1");

        // Idempotent upsert by action_key
        catalog
            .upsert_super_agent_follow_up_action(FollowUpActionWrite {
                id: "act-1".into(),
                user_id: "u1".into(),
                workspace_id: "ws-1".into(),
                source_kind: "session".into(),
                source_id: "sess-1".into(),
                action_key: "ev:1".into(),
                status: "pending".into(),
                auth_version: 2,
                created_at: "2026-11-23T00:00:00Z".into(),
                updated_at: "2026-11-23T00:00:00Z".into(),
                record_json: "{}".into(),
            })
            .await
            .unwrap();
        catalog
            .upsert_super_agent_follow_up_action(FollowUpActionWrite {
                id: "act-2".into(),
                user_id: "u1".into(),
                workspace_id: "ws-1".into(),
                source_kind: "session".into(),
                source_id: "sess-1".into(),
                action_key: "ev:1".into(),
                status: "completed".into(),
                auth_version: 2,
                created_at: "2026-11-23T00:00:00Z".into(),
                updated_at: "2026-11-23T00:01:00Z".into(),
                record_json: "{\"done\":true}".into(),
            })
            .await
            .unwrap();
        let actions = catalog
            .super_agent_follow_up_actions("u1".into(), None, 10, None, None)
            .await
            .unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].status, "completed");
        assert_eq!(actions[0].id, "act-1");

        // Keyset pagination by status across >200 actions
        for i in 0..5_u32 {
            catalog
                .upsert_super_agent_follow_up_action(FollowUpActionWrite {
                    id: format!("disp-{i:02}"),
                    user_id: "u-page".into(),
                    workspace_id: "ws-1".into(),
                    source_kind: "session".into(),
                    source_id: "sess-1".into(),
                    action_key: format!("disp-key-{i:02}"),
                    status: "dispatched".into(),
                    auth_version: 1,
                    created_at: format!("2026-11-23T00:0{i}:00Z"),
                    updated_at: format!("2026-11-23T00:0{i}:00Z"),
                    record_json: format!("{{\"idx\":{i}}}"),
                })
                .await
                .unwrap();
        }
        let a_page1 = catalog
            .super_agent_follow_up_actions(
                "u-page".into(),
                Some("dispatched".into()),
                2,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            a_page1.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["disp-04", "disp-03"]
        );
        let a_page2 = catalog
            .super_agent_follow_up_actions(
                "u-page".into(),
                Some("dispatched".into()),
                2,
                Some(a_page1[1].created_at.clone()),
                Some(a_page1[1].id.clone()),
            )
            .await
            .unwrap();
        assert_eq!(
            a_page2.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["disp-02", "disp-01"]
        );
        let a_page3 = catalog
            .super_agent_follow_up_actions(
                "u-page".into(),
                Some("dispatched".into()),
                2,
                Some(a_page2[1].created_at.clone()),
                Some(a_page2[1].id.clone()),
            )
            .await
            .unwrap();
        assert_eq!(
            a_page3.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["disp-00"]
        );

        // Exact lookup beyond 1,000 newer runs + storage-level monotonic guard
        catalog
            .upsert_super_agent_follow_up_run(FollowUpRunWrite {
                id: "old-run-id".into(),
                user_id: "u1".into(),
                workspace_id: "ws-deep".into(),
                source_kind: "schedule".into(),
                source_id: "sched-deep".into(),
                run_key: "run:old-1".into(),
                created_at: "2026-01-01T00:00:00.000Z".into(),
                updated_at: "2026-01-01T00:00:01.000Z".into(),
                record_json: serde_json::json!({
                    "id": "old-run-id",
                    "status": "completed",
                    "delivered": true,
                    "deliveredMessageId": "msg-old-1",
                    "summary": "Delivered old report",
                    "evidenceRefs": { "sessionId": "sess-old-1", "turnId": "turn-old-1" },
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:01.000Z"
                })
                .to_string(),
            })
            .await
            .unwrap();
        for i in 0..1_010_u32 {
            let mins = i / 60;
            let secs = i % 60;
            let ts = format!(
                "2026-01-02T{:02}:{:02}:{:02}.000Z",
                mins / 60,
                mins % 60,
                secs
            );
            catalog
                .upsert_super_agent_follow_up_run(FollowUpRunWrite {
                    id: format!("newer-{i:04}"),
                    user_id: "u1".into(),
                    workspace_id: "ws-deep".into(),
                    source_kind: "schedule".into(),
                    source_id: "sched-deep".into(),
                    run_key: format!("run:newer-{i:04}"),
                    created_at: ts.clone(),
                    updated_at: ts,
                    record_json: serde_json::json!({ "status": "completed", "delivered": false })
                        .to_string(),
                })
                .await
                .unwrap();
        }
        let fetched = catalog
            .super_agent_follow_up_run(
                "u1".into(),
                "ws-deep".into(),
                "schedule".into(),
                "sched-deep".into(),
                "run:old-1".into(),
            )
            .await
            .unwrap()
            .expect("exact lookup must find run beyond 1,000 newer records");
        assert_eq!(fetched.id, "old-run-id");

        // Attempting to overwrite the old completed+delivered row with claimed/undelivered must be rejected monotonically!
        let guarded = catalog
            .upsert_super_agent_follow_up_run(FollowUpRunWrite {
                id: "late-id".into(),
                user_id: "u1".into(),
                workspace_id: "ws-deep".into(),
                source_kind: "schedule".into(),
                source_id: "sched-deep".into(),
                run_key: "run:old-1".into(),
                created_at: "2026-01-01T00:00:00.000Z".into(),
                updated_at: "2026-01-03T00:00:00.000Z".into(),
                record_json: serde_json::json!({
                    "id": "late-id",
                    "status": "claimed",
                    "delivered": false,
                    "summary": "Running scheduled task",
                    "updatedAt": "2026-01-03T00:00:00.000Z"
                })
                .to_string(),
            })
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&guarded.record_json).unwrap();
        assert_eq!(parsed["status"], "completed");
        assert_eq!(parsed["delivered"], true);
        assert_eq!(parsed["deliveredMessageId"], "msg-old-1");
        assert_eq!(parsed["summary"], "Delivered old report");

        catalog.close().await.unwrap();
    }
}
