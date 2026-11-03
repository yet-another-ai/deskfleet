use super::effective_plan;
use crate::entities::{
    cp_machine_registrations as registrations, cp_session_admissions as admissions,
    cp_teams as teams,
};
use crate::{ControlStore, Error, Result, now_ms, one_query, resource_id};
use sea_orm::sea_query::{
    Asterisk, Cond, Expr, ExprTrait, Func, JoinType, LockType, Order, Query, SelectStatement,
};
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::{Value, json};

fn admission(row: QueryResult) -> Result<Value> {
    let id: String = row.try_get("", "id")?;
    Ok(
        json!({"admissionId":id,"generation":id,"status":row.try_get::<String>("","status")?,"sessionId":row.try_get::<Option<String>>("","session_id")?}),
    )
}

pub(super) fn active_admissions(team: Expr) -> SelectStatement {
    Query::select()
        .from(admissions::Entity)
        .join(
            JoinType::InnerJoin,
            registrations::Entity,
            Expr::col((registrations::Entity, registrations::Column::Id)).eq(Expr::col((
                admissions::Entity,
                admissions::Column::RegistrationId,
            ))),
        )
        .and_where(Expr::col((admissions::Entity, admissions::Column::TeamId)).eq(team))
        .and_where(Expr::col((admissions::Entity, admissions::Column::Status)).ne("released"))
        .to_owned()
}

impl ControlStore {
    /// The caller holds the Team lock, serializing reactivation with reservations.
    pub(crate) async fn check_registration_capacity(
        &self,
        db: &impl ConnectionTrait,
        team: i64,
        registration: i64,
    ) -> Result<()> {
        if let Some(limit) = effective_plan(db, team, self.hosted, now_ms())
            .await?
            .limits()
            .max_active_sessions
        {
            let counts = one_query(
                db,
                active_admissions(Expr::val(team))
                    .expr_as(Expr::col(Asterisk).count(), "total")
                    .expr_as(
                        Func::count(
                            Expr::case(
                                Expr::col((registrations::Entity, registrations::Column::Id))
                                    .eq(registration),
                                1,
                            )
                            .finally(Option::<i32>::None),
                        ),
                        "returning",
                    )
                    .cond_where(
                        Cond::any()
                            .add(
                                Expr::col((registrations::Entity, registrations::Column::Revoked))
                                    .not(),
                            )
                            .add(
                                Expr::col((registrations::Entity, registrations::Column::Id))
                                    .eq(registration),
                            ),
                    ),
            )
            .await?;
            if counts.try_get::<i64>("", "returning")? > 0
                && counts.try_get::<i64>("", "total")? > limit
            {
                return Err(Error::Conflict("active_session_limit"));
            }
        }
        Ok(())
    }

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
        let team: i64 = one_query(
            &tx,
            Query::select()
                .column(registrations::Column::TeamId)
                .from(registrations::Entity)
                .and_where(Expr::col(registrations::Column::Id).eq(machine))
                .and_where(Expr::col(registrations::Column::Revoked).not()),
        )
        .await?
        .try_get("", "team_id")?;
        one_query(
            &tx,
            Query::select()
                .column(teams::Column::Id)
                .from(teams::Entity)
                .and_where(Expr::col(teams::Column::Id).eq(team))
                .lock(LockType::Update),
        )
        .await?;
        // Team precedes Machine locks, matching authorized Machine mutations.
        one_query(
            &tx,
            Query::select()
                .column(registrations::Column::Id)
                .from(registrations::Entity)
                .and_where(Expr::col(registrations::Column::Id).eq(machine))
                .and_where(Expr::col(registrations::Column::TeamId).eq(team))
                .and_where(Expr::col(registrations::Column::Revoked).not())
                .lock(LockType::Share),
        )
        .await?;
        if let Some(row) = tx
            .query_one(
                Query::select()
                    .column(Asterisk)
                    .from(admissions::Entity)
                    .and_where(Expr::col(admissions::Column::Id).eq(operation_id)),
            )
            .await?
        {
            if row.try_get::<i64>("", "registration_id")? != machine
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
            let count: i64 = one_query(
                &tx,
                active_admissions(Expr::val(team))
                    .expr_as(Expr::col(Asterisk).count(), "count")
                    .and_where(
                        Expr::col((registrations::Entity, registrations::Column::Revoked)).not(),
                    ),
            )
            .await?
            .try_get("", "count")?;
            if count >= limit {
                return Err(Error::Conflict("active_session_limit"));
            }
        }
        if let Some(id) = session_id
            && tx
                .query_one(
                    Query::select()
                        .column(admissions::Column::Id)
                        .from(admissions::Entity)
                        .and_where(Expr::col(admissions::Column::RegistrationId).eq(machine))
                        .and_where(Expr::col(admissions::Column::SessionId).eq(id))
                        .and_where(Expr::col(admissions::Column::Status).ne("released")),
                )
                .await?
                .is_some()
        {
            return Err(Error::Conflict("session already has an active admission"));
        }
        let row = one_query(
            &tx,
            Query::insert()
                .into_table(admissions::Entity)
                .columns([
                    admissions::Column::Id,
                    admissions::Column::TeamId,
                    admissions::Column::RegistrationId,
                    admissions::Column::Kind,
                    admissions::Column::RequestedSessionId,
                    admissions::Column::SessionId,
                    admissions::Column::Status,
                    admissions::Column::CreatedAt,
                ])
                .values_panic([
                    operation_id.into(),
                    team.into(),
                    machine.into(),
                    kind.into(),
                    session_id.into(),
                    session_id.into(),
                    "reserved".into(),
                    now_ms().into(),
                ])
                .returning_all(),
        )
        .await?;
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
        let row = one_query(
            &tx,
            Query::select()
                .column((admissions::Entity, Asterisk))
                .from(admissions::Entity)
                .join(
                    JoinType::InnerJoin,
                    registrations::Entity,
                    Expr::col((registrations::Entity, registrations::Column::Id)).eq(Expr::col((
                        admissions::Entity,
                        admissions::Column::RegistrationId,
                    ))),
                )
                .and_where(Expr::col((admissions::Entity, admissions::Column::Id)).eq(id))
                .and_where(
                    Expr::col((admissions::Entity, admissions::Column::RegistrationId))
                        .eq(resource_id(machine_id)?),
                )
                .and_where(Expr::col((registrations::Entity, registrations::Column::Revoked)).not())
                .lock_with_tables(LockType::Update, [admissions::Entity]),
        )
        .await?;
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
        let row = one_query(
            &tx,
            Query::update()
                .table(admissions::Entity)
                .value(admissions::Column::Status, "committed")
                .value(admissions::Column::SessionId, session_id)
                .and_where(Expr::col(admissions::Column::Id).eq(id))
                .returning_all(),
        )
        .await?;
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
        let row = one_query(
            &tx,
            Query::select()
                .column(admissions::Column::Status)
                .from(admissions::Entity)
                .and_where(Expr::col(admissions::Column::Id).eq(id))
                .and_where(
                    Expr::col(admissions::Column::RegistrationId).eq(resource_id(machine_id)?),
                )
                .lock(LockType::Update),
        )
        .await?;
        if row.try_get::<String>("", "status")? == "committed" {
            return Err(Error::Conflict(
                "committed sessions require an archive acknowledgement",
            ));
        }
        tx.execute(
            Query::update()
                .table(admissions::Entity)
                .value(admissions::Column::Status, "released")
                .and_where(Expr::col(admissions::Column::Id).eq(id)),
        )
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
        self.db
            .execute(
                Query::update()
                    .table(admissions::Entity)
                    .value(admissions::Column::Status, "released")
                    .and_where(Expr::col(admissions::Column::Id).eq(generation))
                    .and_where(
                        Expr::col(admissions::Column::RegistrationId).eq(resource_id(machine_id)?),
                    )
                    .and_where(Expr::col(admissions::Column::SessionId).eq(session_id)),
            )
            .await?;
        Ok(())
    }

    pub async fn session_admissions(&self, machine_id: &str) -> Result<Vec<Value>> {
        self.db
            .query_all(
                Query::select()
                    .column((admissions::Entity, Asterisk))
                    .from(admissions::Entity)
                    .join(
                        JoinType::InnerJoin,
                        registrations::Entity,
                        Expr::col((registrations::Entity, registrations::Column::Id)).eq(
                            Expr::col((admissions::Entity, admissions::Column::RegistrationId)),
                        ),
                    )
                    .and_where(
                        Expr::col((admissions::Entity, admissions::Column::RegistrationId))
                            .eq(resource_id(machine_id)?),
                    )
                    .and_where(
                        Expr::col((admissions::Entity, admissions::Column::Status)).ne("released"),
                    )
                    .and_where(
                        Expr::col((registrations::Entity, registrations::Column::Revoked)).not(),
                    )
                    .order_by(
                        (admissions::Entity, admissions::Column::CreatedAt),
                        Order::Asc,
                    ),
            )
            .await?
            .into_iter()
            .map(admission)
            .collect()
    }
}
