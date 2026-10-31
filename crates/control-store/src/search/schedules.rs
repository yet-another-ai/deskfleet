use std::collections::{HashMap, HashSet};

use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Map, Value, json};

use super::{blocks, write_document};
use crate::{ControlStore, Error, Result, now_ms, one, resource_id, sql, timestamp};

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
        one(
            &tx,
            "SELECT id FROM cp_machines WHERE id=$1 FOR UPDATE",
            vec![machine.into()],
        )
        .await?;
        let rows = tx
            .query_all_raw(sql(
                "SELECT schedule_id,record FROM cp_schedules WHERE machine_id=$1",
                vec![machine.into()],
            ))
            .await?;
        let mut existing = HashSet::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("", "schedule_id")?;
            let old: Value = row.try_get("", "record")?;
            existing.insert(id.clone());
            if let Some(task) = incoming.get(&id) {
                if task != &old {
                    tx.execute_raw(sql(
                        "UPDATE cp_schedules SET record=$3 WHERE machine_id=$1 AND schedule_id=$2",
                        vec![machine.into(), id.as_str().into(), task.clone().into()],
                    ))
                    .await?;
                    if task["title"] != old["title"] || task["prompt"] != old["prompt"] {
                        index_task(&tx, machine, &id, Some(task)).await?;
                    }
                }
            } else {
                tx.execute_raw(sql(
                    "DELETE FROM cp_schedules WHERE machine_id=$1 AND schedule_id=$2",
                    vec![machine.into(), id.as_str().into()],
                ))
                .await?;
                index_task(&tx, machine, &id, None).await?;
            }
        }
        for (id, task) in incoming {
            if existing.contains(&id) {
                continue;
            }
            tx.execute_raw(sql(
                "INSERT INTO cp_schedules(machine_id,schedule_id,record) VALUES($1,$2,$3)",
                vec![machine.into(), id.as_str().into(), task.clone().into()],
            ))
            .await?;
            index_task(&tx, machine, &id, Some(&task)).await?;
        }
        tx.execute_raw(sql(
            "INSERT INTO cp_schedule_snapshots(machine_id,observed_at) VALUES($1,$2) ON CONFLICT(machine_id) DO UPDATE SET observed_at=excluded.observed_at",
            vec![machine.into(),now_ms().into()],
        )).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Read the last published public inventory, including while offline.
    ///
    /// # Errors
    /// Returns an error for invalid machine IDs or database failures.
    pub async fn schedule_snapshot(&self, machine_id: &str) -> Result<Value> {
        let machine = resource_id(machine_id)?;
        let row = one(&self.db,
            "SELECT (SELECT observed_at FROM cp_schedule_snapshots WHERE machine_id=$1) AS observed_at,
             COALESCE((SELECT jsonb_agg(record ORDER BY schedule_id) FROM cp_schedules WHERE machine_id=$1),'[]'::jsonb) AS tasks",
            vec![machine.into()],
        ).await?;
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
    db.execute_raw(sql("DELETE FROM cp_search_documents WHERE machine_id=$1 AND kind='schedule' AND resource_id=$2",vec![machine.into(),id.into()])).await?;
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
