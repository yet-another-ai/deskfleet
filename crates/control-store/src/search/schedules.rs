use std::collections::{HashMap, HashSet};

use crate::entities::{
    cp_machine_registrations as registrations, cp_schedule_snapshots as snapshots,
    cp_schedules as schedules, cp_search_documents as documents,
};
use sea_orm::{
    ConnectionTrait, EntityTrait, Set, TransactionTrait,
    sea_query::{Alias, Expr, ExprTrait, Func, OnConflict, Query},
};
use serde_json::{Map, Value, json};

use super::{blocks, write_document};
use crate::{ControlStore, Error, Result, now_ms, one_query, resource_id, timestamp};

impl ControlStore {
    /// Publish the daemon's complete public schedule inventory for offline reads.
    /// Execution and all mutations remain owned by that daemon.
    ///
    /// # Errors
    /// Rejects malformed public tasks or a missing machine, and database failures.
    pub async fn sync_schedules(&self, machine_id: &str, tasks: Value) -> Result<()> {
        let machine = resource_id(machine_id)?;
        let tasks = tasks
            .as_array()
            .ok_or(Error::Invalid("invalid schedule snapshot"))?;
        let mut incoming = HashMap::with_capacity(tasks.len());
        for task in tasks {
            let task = public_task(task)?;
            let id = task["id"]
                .as_str()
                .expect("validated schedule id")
                .to_owned();
            if incoming.insert(id, task).is_some() {
                return Err(Error::Invalid("duplicate schedule id"));
            }
        }
        let tx = self.db.begin().await?;
        one_query(
            &tx,
            Query::select()
                .column(registrations::Column::Id)
                .from(registrations::Entity)
                .and_where(Expr::col(registrations::Column::Id).eq(machine))
                .lock_exclusive(),
        )
        .await?;
        let rows = tx
            .query_all(
                Query::select()
                    .columns([schedules::Column::ScheduleId, schedules::Column::Record])
                    .from(schedules::Entity)
                    .and_where(Expr::col(schedules::Column::RegistrationId).eq(machine)),
            )
            .await?;
        let mut existing = HashSet::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("", "schedule_id")?;
            let old: Value = row.try_get("", "record")?;
            existing.insert(id.clone());
            if let Some(task) = incoming.get(&id) {
                if task != &old {
                    tx.execute(
                        Query::update()
                            .table(schedules::Entity)
                            .value(schedules::Column::Record, task.clone())
                            .and_where(Expr::col(schedules::Column::RegistrationId).eq(machine))
                            .and_where(Expr::col(schedules::Column::ScheduleId).eq(id.as_str())),
                    )
                    .await?;
                    if task["title"] != old["title"] || task["prompt"] != old["prompt"] {
                        index_task(&tx, machine, &id, Some(task)).await?;
                    }
                }
            } else {
                tx.execute(
                    Query::delete()
                        .from_table(schedules::Entity)
                        .and_where(Expr::col(schedules::Column::RegistrationId).eq(machine))
                        .and_where(Expr::col(schedules::Column::ScheduleId).eq(id.as_str())),
                )
                .await?;
                index_task(&tx, machine, &id, None).await?;
            }
        }
        for (id, task) in incoming {
            if existing.contains(&id) {
                continue;
            }
            schedules::Entity::insert(schedules::ActiveModel {
                registration_id: Set(machine),
                schedule_id: Set(id.clone()),
                record: Set(task.clone()),
            })
            .exec_without_returning(&tx)
            .await?;
            index_task(&tx, machine, &id, Some(&task)).await?;
        }
        snapshots::Entity::insert(snapshots::ActiveModel {
            registration_id: Set(machine),
            observed_at: Set(now_ms()),
        })
        .on_conflict(
            OnConflict::column(snapshots::Column::RegistrationId)
                .update_column(snapshots::Column::ObservedAt)
                .to_owned(),
        )
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Read the last published public inventory, including while offline.
    ///
    /// # Errors
    /// Returns an error for invalid machine IDs or database failures.
    pub async fn schedule_snapshot(&self, machine_id: &str) -> Result<Value> {
        let machine = resource_id(machine_id)?;
        let observed = Query::select()
            .column(snapshots::Column::ObservedAt)
            .from(snapshots::Entity)
            .and_where(Expr::col(snapshots::Column::RegistrationId).eq(machine))
            .to_owned();
        // SeaQuery does not expose ORDER BY inside an aggregate argument.
        let tasks = Query::select()
            .expr(Expr::cust_with_exprs(
                "jsonb_agg($1 ORDER BY $2)",
                [
                    Expr::col(schedules::Column::Record),
                    Expr::col(schedules::Column::ScheduleId),
                ],
            ))
            .from(schedules::Entity)
            .and_where(Expr::col(schedules::Column::RegistrationId).eq(machine))
            .to_owned();
        let row = one_query(
            &self.db,
            Query::select()
                .expr_as(Expr::from(observed), Alias::new("observed_at"))
                .expr_as(
                    Func::coalesce([Expr::from(tasks), Expr::val("[]").cast_as("jsonb")]),
                    Alias::new("tasks"),
                ),
        )
        .await?;
        let observed: Option<i64> = row.try_get("", "observed_at")?;
        Ok(
            json!({"tasks":row.try_get::<Value>("","tasks")?,"lastObservedAt":observed.map(timestamp)}),
        )
    }
}

async fn index_task(
    db: &impl ConnectionTrait,
    machine: i64,
    id: &str,
    task: Option<&Value>,
) -> Result<()> {
    db.execute(
        Query::delete()
            .from_table(documents::Entity)
            .and_where(Expr::col(documents::Column::RegistrationId).eq(machine))
            .and_where(Expr::col(documents::Column::Kind).eq("schedule"))
            .and_where(Expr::col(documents::Column::ResourceId).eq(id)),
    )
    .await?;
    if let Some(task) = task {
        write_document(
            db,
            machine,
            "schedule",
            id,
            "$title",
            0,
            0,
            task["title"].as_str().expect("validated title"),
        )
        .await?;
        for (block, content) in blocks(task["prompt"].as_str().expect("validated prompt"))
            .iter()
            .enumerate()
        {
            write_document(
                db,
                machine,
                "schedule",
                id,
                "$prompt",
                block as i64,
                1,
                content,
            )
            .await?;
        }
    }
    Ok(())
}

fn public_task(task: &Value) -> Result<Value> {
    for (key, limit) in [
        ("id", 200),
        ("title", 200),
        ("prompt", 100_000),
        ("workspaceId", 19),
        ("createdAt", 100),
        ("updatedAt", 100),
    ] {
        let value = task[key]
            .as_str()
            .ok_or(Error::Invalid("invalid public schedule"))?;
        if value.trim().is_empty() || value.contains('\0') || value.chars().count() > limit {
            return Err(Error::Invalid("invalid public schedule"));
        }
    }
    resource_id(
        task["workspaceId"]
            .as_str()
            .expect("validated workspace id"),
    )?;
    if !task["enabled"].is_boolean()
        || !task["target"].is_object()
        || !task["trigger"].is_object()
        || !task["runs"].is_array()
    {
        return Err(Error::Invalid("invalid public schedule"));
    }
    let mut public = Map::new();
    for key in [
        "id",
        "title",
        "prompt",
        "workspaceId",
        "enabled",
        "target",
        "trigger",
        "createdAt",
        "updatedAt",
        "nextRunAt",
        "runs",
        "lastRun",
    ] {
        if let Some(value) = task.get(key) {
            public.insert(key.to_owned(), value.clone());
        }
    }
    Ok(Value::Object(public))
}
