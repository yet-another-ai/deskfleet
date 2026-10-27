use super::effective_plan;
use crate::{ControlStore, Error, Result, json_rows, now_ms, one, resource_id, sql};
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::{Value, json};

fn admission(row: QueryResult) -> Result<Value> {
    let id: String = row.try_get("", "id")?;
    Ok(
        json!({"admissionId":id,"generation":id,"status":row.try_get::<String>("","status")?,"sessionId":row.try_get::<Option<String>>("","session_id")?}),
    )
}

impl ControlStore {
    /// Reservation is durable until the owning daemon proves its result. No timeout
    /// can safely release an operation whose local commit is unknown.
    pub async fn reserve_session(
        &self,
        machine_id: &str,
        operation_id: &str,
        kind: &str,
        session_id: Option<&str>,
    ) -> Result<Value> {
        uuid::Uuid::parse_str(operation_id)
            .map_err(|_| Error::Invalid("operationId must be a UUID"))?;
        if !matches!(kind, "create" | "fork" | "restore")
            || (kind == "restore" && session_id.is_none())
        {
            return Err(Error::Invalid("invalid session admission"));
        }
        if let Some(id) = session_id {
            resource_id(id)?;
        }
        let machine = resource_id(machine_id)?;
        let tx = self.db.begin().await?;
        let team: i64 = one(
            &tx,
            "SELECT team_id FROM cp_machines WHERE id=$1 AND NOT revoked FOR SHARE",
            vec![machine.into()],
        )
        .await?
        .try_get("", "team_id")?;
        one(
            &tx,
            "SELECT id FROM cp_teams WHERE id=$1 FOR UPDATE",
            vec![team.into()],
        )
        .await?;
        if let Some(row) = tx
            .query_one_raw(sql(
                "SELECT * FROM cp_session_admissions WHERE id=$1",
                vec![operation_id.into()],
            ))
            .await?
        {
            if row.try_get::<i64>("", "machine_id")? != machine
                || row.try_get::<String>("", "kind")? != kind
                || row
                    .try_get::<Option<String>>("", "requested_session_id")?
                    .as_deref()
                    != session_id
            {
                return Err(Error::Conflict(
                    "operationId is already bound to another operation",
                ));
            }
            return admission(row);
        }
        let plan = effective_plan(&tx, team, self.hosted, now_ms()).await?;
        if let Some(limit) = plan.limits().max_active_sessions {
            let count:i64=one(&tx,"SELECT COUNT(*) AS count FROM cp_session_admissions a JOIN cp_machines m ON m.id=a.machine_id WHERE a.team_id=$1 AND a.status<>'released' AND NOT m.revoked",vec![team.into()]).await?.try_get("","count")?;
            if count >= limit {
                return Err(Error::Conflict("active_session_limit"));
            }
        }
        if let Some(id) = session_id
            && tx.query_one_raw(sql("SELECT id FROM cp_session_admissions WHERE machine_id=$1 AND session_id=$2 AND status<>'released'",vec![machine.into(),id.into()])).await?.is_some() {
                return Err(Error::Conflict("session already has an active admission"));
        }
        let row=one(&tx,"INSERT INTO cp_session_admissions(id,team_id,machine_id,kind,requested_session_id,session_id,status,created_at) VALUES($1,$2,$3,$4,$5,$5,'reserved',$6) RETURNING *",vec![operation_id.into(),team.into(),machine.into(),kind.into(),session_id.map(str::to_owned).into(),now_ms().into()]).await?;
        tx.commit().await?;
        admission(row)
    }

    pub async fn confirm_session_admission(
        &self,
        machine_id: &str,
        id: &str,
        generation: &str,
        session_id: &str,
    ) -> Result<Value> {
        if id != generation {
            return Err(Error::Conflict("stale admission generation"));
        }
        resource_id(session_id)?;
        let tx = self.db.begin().await?;
        let row=one(&tx,"SELECT a.* FROM cp_session_admissions a JOIN cp_machines m ON m.id=a.machine_id WHERE a.id=$1 AND a.machine_id=$2 AND NOT m.revoked FOR UPDATE OF a",vec![id.into(),resource_id(machine_id)?.into()]).await?;
        let status: String = row.try_get("", "status")?;
        let existing: Option<String> = row.try_get("", "session_id")?;
        if existing.as_deref().is_some_and(|value| value != session_id) {
            return Err(Error::Conflict("admission is bound to another session"));
        }
        if status == "released" {
            return if existing.as_deref() == Some(session_id) {
                admission(row)
            } else {
                Err(Error::Conflict("admission was already cancelled"))
            };
        }
        let row=one(&tx,"UPDATE cp_session_admissions SET status='committed',session_id=$2 WHERE id=$1 RETURNING *",vec![id.into(),session_id.into()]).await?;
        tx.commit().await?;
        admission(row)
    }

    pub async fn cancel_session_admission(
        &self,
        machine_id: &str,
        id: &str,
        generation: &str,
    ) -> Result<()> {
        if id != generation {
            return Err(Error::Conflict("stale admission generation"));
        }
        let tx = self.db.begin().await?;
        let row = one(
            &tx,
            "SELECT status FROM cp_session_admissions WHERE id=$1 AND machine_id=$2 FOR UPDATE",
            vec![id.into(), resource_id(machine_id)?.into()],
        )
        .await?;
        if row.try_get::<String>("", "status")? == "committed" {
            return Err(Error::Conflict(
                "committed sessions require an archive acknowledgement",
            ));
        }
        tx.execute_raw(sql(
            "UPDATE cp_session_admissions SET status='released' WHERE id=$1",
            vec![id.into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn release_session_admission(
        &self,
        machine_id: &str,
        session_id: &str,
        generation: &str,
    ) -> Result<()> {
        // Generation belongs to the durable local lifecycle. Late archive retries
        // cannot touch the reservation created by a subsequent restore.
        self.db.execute_raw(sql("UPDATE cp_session_admissions SET status='released' WHERE id=$1 AND machine_id=$2 AND session_id=$3",vec![generation.into(),resource_id(machine_id)?.into(),session_id.into()])).await?;
        Ok(())
    }

    pub async fn session_admissions(&self, machine_id: &str) -> Result<Vec<Value>> {
        json_rows(&self.db,"SELECT jsonb_build_object('admissionId',id,'generation',id,'status',status,'sessionId',session_id) AS record FROM cp_session_admissions WHERE machine_id=$1 AND status<>'released' ORDER BY created_at",vec![resource_id(machine_id)?.into()]).await
    }
}
