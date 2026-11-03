use sea_orm::ConnectionTrait;
use sea_orm::DeriveIden;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, ExprTrait, Func, JoinType, Order, Query};

use super::types::{Turn, Usage};
use crate::entities::{
    cp_ai_turns as turns, cp_machine_registrations as registrations, cp_sessions as sessions,
    cp_users as users,
};
use crate::{ControlStore, Error, Result, one_query, resource_id};

#[derive(Clone, Copy, DeriveIden)]
enum TimeZones {
    #[sea_orm(iden = "pg_timezone_names")]
    Table,
    Name,
}

pub(super) struct CalendarDay {
    pub date: String,
    pub start: i64,
}

fn timestamp(milliseconds: Expr) -> Expr {
    Func::cust("to_timestamp")
        .arg(
            milliseconds
                .cast_as("bigint")
                .cast_as("double precision")
                .div(1000),
        )
        .into()
}

fn local_time(timestamp: Expr, zone: &str) -> Expr {
    Func::cust("timezone")
        .args([Expr::val(zone), timestamp])
        .into()
}

fn milliseconds(timestamp: Expr) -> Expr {
    // SeaQuery has no EXTRACT syntax. Preserve PostgreSQL's numeric EXTRACT
    // result (date_part returns double precision) before multiplying and casting.
    Expr::cust_with_expr("EXTRACT(EPOCH FROM $1)", timestamp)
        .mul(1000)
        .cast_as("bigint")
}

impl ControlStore {
    pub(super) async fn usage_time_zone(&self, time_zone: &str) -> Result<()> {
        let valid: bool = one_query(
            &self.db,
            Query::select().expr_as(
                Expr::exists(
                    Query::select()
                        .expr(Expr::val(1))
                        .from(TimeZones::Table)
                        .and_where(Expr::col(TimeZones::Name).eq(time_zone))
                        .to_owned(),
                ),
                "valid",
            ),
        )
        .await?
        .try_get("", "valid")?;
        if !valid {
            return Err(Error::Invalid("invalid time zone"));
        }
        Ok(())
    }

    /// Generate local calendar dates independently of the database session zone.
    pub(super) async fn usage_calendar(
        &self,
        time_zone: &str,
        from: &str,
        to: &str,
    ) -> Result<Vec<CalendarDay>> {
        let day = Expr::col("day");
        self.db
            .query_all(
                Query::select()
                    .expr_as(day.clone().cast_as("date").cast_as("text"), "date")
                    .expr_as(milliseconds(local_time(day, time_zone)), "start")
                    .from_function(
                        Func::cust("generate_series").args([
                            Expr::val(from)
                                .cast_as("text")
                                .cast_as("date")
                                .cast_as("timestamp"),
                            Expr::val(to)
                                .cast_as("text")
                                .cast_as("date")
                                .cast_as("timestamp"),
                            Expr::val("1 day").cast_as("interval"),
                        ]),
                        "day",
                    )
                    .order_by("day", Order::Asc),
            )
            .await?
            .into_iter()
            .map(|row| {
                Ok(CalendarDay {
                    date: row.try_get("", "date")?,
                    start: row.try_get("", "start")?,
                })
            })
            .collect()
    }

    pub(super) async fn usage_today(&self, time_zone: &str, now: i64) -> Result<String> {
        Ok(one_query(
            &self.db,
            Query::select().expr_as(
                local_time(timestamp(Expr::val(now)), time_zone)
                    .cast_as("date")
                    .cast_as("text"),
                "date",
            ),
        )
        .await?
        .try_get("", "date")?)
    }

    pub(super) async fn usage_last_synced(&self, team_id: &str) -> Result<Option<i64>> {
        Ok(one_query(
            &self.db,
            Query::select()
                .expr_as(
                    Expr::col((sessions::Entity, sessions::Column::ObservedAt)).max(),
                    "observed_at",
                )
                .from(sessions::Entity)
                .join(
                    JoinType::InnerJoin,
                    registrations::Entity,
                    Expr::col((registrations::Entity, registrations::Column::Id)).eq(Expr::col((
                        sessions::Entity,
                        sessions::Column::RegistrationId,
                    ))),
                )
                .and_where(
                    Expr::col((registrations::Entity, registrations::Column::TeamId))
                        .eq(resource_id(team_id)?),
                ),
        )
        .await?
        .try_get("", "observed_at")?)
    }

    /// Read one fact per terminal turn from the current snapshot, never events.
    /// Machine revocation does not remove previously synchronized consumption.
    pub(super) async fn usage_turns(
        &self,
        team_id: &str,
        time_zone: &str,
        from: Option<i64>,
        to: i64,
    ) -> Result<Vec<Turn>> {
        self.db
            .query_all(&turns_query(resource_id(team_id)?, time_zone, from, to))
            .await?
            .into_iter()
            .map(|row| {
                Ok(Turn {
                    ended_at: row.try_get("", "ended_at")?,
                    date: row.try_get("", "date")?,
                    day_start: row.try_get("", "day_start")?,
                    model_id: row.try_get("", "model_id")?,
                    model_name: row.try_get("", "model_name")?,
                    member_id: row.try_get("", "member_id")?,
                    member_name: row.try_get("", "member_name")?,
                    machine_id: row.try_get("", "machine_id")?,
                    machine_name: row.try_get("", "machine_name")?,
                    session_id: row.try_get("", "session_id")?,
                    title: row.try_get("", "title")?,
                    usage: Usage::from_json(&row.try_get("", "usage")?),
                })
            })
            .collect()
    }
}

fn turns_query(
    team_id: i64,
    time_zone: &str,
    from: Option<i64>,
    to: i64,
) -> sea_orm::sea_query::SelectStatement {
    let ended = Expr::col((turns::Entity, turns::Column::EndedAt));
    let model_id = Func::cust("nullif").args([
        Expr::col((turns::Entity, turns::Column::Model)).cast_json_field("id"),
        Expr::val(""),
    ]);
    let model_name = Func::cust("nullif").args([
        Expr::col((turns::Entity, turns::Column::Model)).cast_json_field("name"),
        Expr::val(""),
    ]);
    Query::select()
        .expr_as(
            Expr::col((registrations::Entity, registrations::Column::MachineId)).cast_as("text"),
            "machine_id",
        )
        .expr_as(
            Expr::col((registrations::Entity, registrations::Column::Name)),
            "machine_name",
        )
        .column((turns::Entity, turns::Column::SessionId))
        .expr_as(
            Func::coalesce([
                Expr::col((sessions::Entity, sessions::Column::Summary))
                    .get_json_field("session")
                    .cast_json_field("title"),
                Expr::val(""),
            ]),
            "title",
        )
        .expr_as(milliseconds(ended.clone()), "ended_at")
        .expr_as(
            local_time(ended.clone(), time_zone)
                .cast_as("date")
                .cast_as("text"),
            "date",
        )
        .expr_as(
            milliseconds(local_time(
                Func::cust("date_trunc")
                    .args([Expr::val("day"), local_time(ended.clone(), time_zone)])
                    .into(),
                time_zone,
            )),
            "day_start",
        )
        .expr_as(
            Func::coalesce([Expr::from(model_id.clone()), Expr::val("unknown")]),
            "model_id",
        )
        .expr_as(
            Func::coalesce([Expr::from(model_name), Expr::from(model_id), Expr::val("")]),
            "model_name",
        )
        .expr_as(
            Func::coalesce([
                Func::cust("nullif")
                    .args([
                        Expr::col((turns::Entity, turns::Column::MemberId)),
                        Expr::val(""),
                    ])
                    .into(),
                Expr::val("unknown"),
            ]),
            "member_id",
        )
        .expr_as(
            Func::coalesce([
                Expr::col((users::Entity, users::Column::Name)),
                Expr::val(""),
            ]),
            "member_name",
        )
        .expr_as(
            Func::coalesce([
                Expr::col((turns::Entity, turns::Column::Usage)),
                Expr::val(serde_json::Value::Null),
            ]),
            "usage",
        )
        .from(turns::Entity)
        .join(
            JoinType::InnerJoin,
            registrations::Entity,
            Expr::col((registrations::Entity, registrations::Column::Id))
                .eq(Expr::col((turns::Entity, turns::Column::RegistrationId))),
        )
        .join(
            JoinType::InnerJoin,
            sessions::Entity,
            Expr::col((sessions::Entity, sessions::Column::RegistrationId))
                .eq(Expr::col((turns::Entity, turns::Column::RegistrationId)))
                .and(
                    Expr::col((sessions::Entity, sessions::Column::SessionId))
                        .eq(Expr::col((turns::Entity, turns::Column::SessionId))),
                ),
        )
        .join(
            JoinType::LeftJoin,
            users::Entity,
            Expr::col((users::Entity, users::Column::Id))
                .eq(Expr::col((turns::Entity, turns::Column::MemberId))),
        )
        .and_where(Expr::col((registrations::Entity, registrations::Column::TeamId)).eq(team_id))
        .and_where(ended.clone().gte(Func::coalesce([
            timestamp(Expr::val(from)),
            Expr::val("-infinity").cast_as("timestamptz"),
        ])))
        .and_where(ended.lt(timestamp(Expr::val(to))))
        .order_by((turns::Entity, turns::Column::EndedAt), Order::Asc)
        .order_by((turns::Entity, turns::Column::RegistrationId), Order::Asc)
        .order_by((turns::Entity, turns::Column::SessionId), Order::Asc)
        .order_by((turns::Entity, turns::Column::TurnId), Order::Asc)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, DbBackend, Statement};
    use serde_json::json;

    #[tokio::test]
    #[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
    async fn usage_date_query_uses_time_index_without_expanding_history() {
        let base = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let admin = Database::connect(&base).await.unwrap();
        let schema = format!("usage_query_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if base.as_str().contains('?') {
            '&'
        } else {
            '?'
        };
        let store = ControlStore::connect(&format!(
            "{base}{separator}options=-csearch_path%3D{schema}"
        ))
        .await
        .unwrap();
        let owner = store
            .verified_user("owner@usage-query.test", "Owner")
            .await
            .unwrap();
        let team = store.create_team(&owner.id, "Team").await.unwrap();
        let machine = store
            .enroll(
                &owner.id,
                &team.id,
                "Machine",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
                &crate::secret(),
            )
            .await
            .unwrap()
            .0;
        store
            .sync_history(
                &machine.id,
                "1",
                json!({"session":{"id":"1","lastEventSeq":"0"},"turns":[]}),
                vec![],
                vec![],
            )
            .await
            .unwrap();
        store.database().execute_unprepared(
            "UPDATE cp_sessions SET snapshot=jsonb_set(snapshot,'{turns}',(SELECT jsonb_agg(jsonb_build_object('id',g::text,'state','completed','endedAt','2020-01-01'::timestamptz+g*interval '1 minute')) FROM generate_series(1,20000) g))",
        ).await.unwrap();
        store
            .database()
            .execute_unprepared(
                "ANALYZE cp_ai_turns; ANALYZE cp_machine_registrations; ANALYZE cp_sessions",
            )
            .await
            .unwrap();
        let statement = DbBackend::Postgres.build(&turns_query(
            team.id.parse().unwrap(),
            "UTC",
            Some(1_577_836_800_000),
            1_577_923_200_000,
        ));
        // EXPLAIN wraps the production builder's SQL and retains its bindings.
        let row = store
            .database()
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}", statement.sql),
                statement.values.unwrap().0,
            ))
            .await
            .unwrap()
            .unwrap();
        let plan: serde_json::Value = row.try_get("", "QUERY PLAN").unwrap();
        let text = plan.to_string();
        assert!(text.as_str().contains("cp_ai_turns_machine_time"), "{plan}");
        assert!(!text.as_str().contains("Function Scan"), "{plan}");
        println!("AI usage date plan: {plan}");
        store.close().await.unwrap();
        admin
            .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
            .await
            .unwrap();
        admin.close().await.unwrap();
    }
}
