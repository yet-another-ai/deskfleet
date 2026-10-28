use sea_orm::ConnectionTrait;

use super::types::{Turn, Usage};
use crate::{ControlStore, Error, Result, one, resource_id, sql};

pub(super) struct CalendarDay {
    pub date: String,
    pub start: i64,
}

impl ControlStore {
    pub(super) async fn usage_time_zone(&self, time_zone: &str) -> Result<()> {
        let valid: bool = one(
            &self.db,
            "SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1) AS valid",
            vec![time_zone.into()],
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
        self.db
            .query_all_raw(sql(
                "SELECT day::date::text AS date,
                    (EXTRACT(EPOCH FROM (day AT TIME ZONE $1)) * 1000)::bigint AS start
                 FROM generate_series($2::text::date::timestamp, $3::text::date::timestamp, INTERVAL '1 day') AS day
                 ORDER BY day",
                vec![time_zone.into(), from.into(), to.into()],
            ))
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
        Ok(one(
            &self.db,
            "SELECT (to_timestamp($2::bigint::double precision / 1000) AT TIME ZONE $1)::date::text AS date",
            vec![time_zone.into(), now.into()],
        )
        .await?
        .try_get("", "date")?)
    }

    pub(super) async fn usage_last_synced(&self, team_id: &str) -> Result<Option<i64>> {
        Ok(one(
            &self.db,
            "SELECT MAX(s.observed_at) AS observed_at FROM cp_sessions s
             JOIN cp_machines m ON m.id=s.machine_id WHERE m.team_id=$1",
            vec![resource_id(team_id)?.into()],
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
            .query_all_raw(sql(
                include_str!("turns.sql"),
                vec![
                    resource_id(team_id)?.into(),
                    time_zone.into(),
                    from.into(),
                    to.into(),
                ],
            ))
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
