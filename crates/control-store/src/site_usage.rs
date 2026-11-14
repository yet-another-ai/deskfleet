//! Installation-wide daily analytics over retained creation and usage facts.
use std::collections::BTreeMap;

use sea_orm::sea_query::{
    Asterisk, Expr, ExprTrait, Func, IntoTableRef, Query, SelectStatement, TableRef, UnionType,
};
use sea_orm::{ConnectionTrait, DeriveIden, QueryResult};
use serde::Serialize;
use serde_json::{Value, json};

use crate::entities::{
    cp_ai_turns as turns, cp_cloudflare_turn_daily as cloudflare,
    cp_cloudflare_turn_usage as cloudflare_periods, cp_sessions as sessions, cp_teams as teams,
    cp_turn_usage_minutes as relay, cp_users as users,
};
use crate::policies::{SiteAction, SitePolicy, authorize};
use crate::{ControlStore, Error, Result, now_ms, one_query, timestamp};

const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Copy, DeriveIden)]
enum UsageColumn {
    Day,
    Count,
    Date,
    Bytes,
    Daily,
    Incomplete,
}

#[derive(Default, Serialize)]
struct Totals {
    users: i64,
    teams: i64,
    sessions: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    date: String,
    users: i64,
    teams: i64,
    sessions: i64,
    turn_count: i64,
    relayed_bytes: String,
}

impl ControlStore {
    /// Return UTC calendar-day counts and synchronized consumption for the site.
    ///
    /// Inventory is measured at each day's end (now for today), includes disabled
    /// users and archived Sessions, and excludes resources deleted by that time.
    /// Revoked registrations retain their historical Sessions and consumption.
    /// Team totals can only include retained Teams: Team deletion is permanent.
    ///
    /// # Errors
    /// Returns an error for non-administrators, unsupported periods or storage errors.
    pub async fn site_usage_trends(&self, actor: &str, period: &str) -> Result<Value> {
        authorize(
            &SitePolicy::new(self.is_site_admin(actor).await?),
            SiteAction::ReadUsage,
        )?;
        let days = match period {
            "7d" => 7,
            "30d" => 30,
            "90d" => 90,
            _ => return Err(Error::Invalid("invalid usage period")),
        };
        let now = now_ms();
        let last_day = now.div_euclid(DAY_MS);
        let first_day = last_day - days + 1;
        let from = first_day * DAY_MS;
        let user_changes = changes(
            self.db
                .query_all(&inventory_query(
                    users::Entity.into_table_ref(),
                    Expr::col(users::Column::CreatedAt),
                    Some(Expr::col(users::Column::DeletedAt)),
                    first_day,
                    now,
                ))
                .await?,
        )?;
        let team_changes = changes(
            self.db
                .query_all(&inventory_query(
                    teams::Entity.into_table_ref(),
                    Expr::col(teams::Column::CreatedAt),
                    None,
                    first_day,
                    now,
                ))
                .await?,
        )?;
        let session_changes = changes(
            self.db
                .query_all(&inventory_query(
                    sessions::Entity.into_table_ref(),
                    Expr::col(sessions::Column::CreatedAt),
                    Some(Expr::col(sessions::Column::DeletedAt)),
                    first_day,
                    now,
                ))
                .await?,
        )?;
        let turn_counts = self
            .db
            .query_all(&turn_query(from, now))
            .await?
            .into_iter()
            .map(|row| {
                Ok((
                    row.try_get::<String>("", "date")?,
                    row.try_get("", "count")?,
                ))
            })
            .collect::<Result<BTreeMap<_, i64>>>()?;
        let relay_bytes = self
            .db
            .query_all(&relay_query(from, now))
            .await?
            .into_iter()
            .map(|row| Ok((row.try_get::<i64>("", "day")?, row.try_get("", "bytes")?)))
            .collect::<Result<BTreeMap<_, String>>>()?;
        let relay_history_incomplete: bool = one_query(
            &self.db,
            Query::select().expr_as(
                Expr::exists(
                    Query::select()
                        .expr(Expr::val(1))
                        .from(cloudflare_periods::Entity)
                        .and_where(Expr::col(cloudflare_periods::Column::PeriodStart).lt(now))
                        .and_where(Expr::col(cloudflare_periods::Column::ExpiresAt).gt(from))
                        .and_where(
                            Expr::col(cloudflare_periods::Column::DailyCollectedAt).is_null(),
                        )
                        .to_owned(),
                ),
                UsageColumn::Incomplete,
            ),
        )
        .await?
        .try_get("", "incomplete")?;
        let mut totals = Totals {
            users: *user_changes.get(&(first_day - 1)).unwrap_or(&0),
            teams: *team_changes.get(&(first_day - 1)).unwrap_or(&0),
            sessions: *session_changes.get(&(first_day - 1)).unwrap_or(&0),
        };
        let mut buckets = Vec::with_capacity(days as usize);
        for day in first_day..=last_day {
            totals.users += user_changes.get(&day).copied().unwrap_or(0);
            totals.teams += team_changes.get(&day).copied().unwrap_or(0);
            totals.sessions += session_changes.get(&day).copied().unwrap_or(0);
            let date = timestamp(day * DAY_MS)[..10].to_owned();
            buckets.push(Bucket {
                turn_count: turn_counts.get(&date).copied().unwrap_or(0),
                relayed_bytes: relay_bytes.get(&day).cloned().unwrap_or_else(|| "0".into()),
                date,
                users: totals.users,
                teams: totals.teams,
                sessions: totals.sessions,
            });
        }
        Ok(json!({
            "period": period,
            "timeZone": "UTC",
            "from": timestamp(from),
            "to": timestamp(now),
            "generatedAt": timestamp(now),
            "totals": totals,
            "buckets": buckets,
            "relayHistoryIncomplete": relay_history_incomplete,
        }))
    }
}

/// Group each inventory table once, rather than counting its entire contents for
/// every requested date. All earlier changes collapse into one opening balance.
fn inventory_query(
    table: TableRef,
    created: Expr,
    deleted: Option<Expr>,
    first_day: i64,
    to: i64,
) -> SelectStatement {
    let mut query = inventory_events(table.clone(), created, false, first_day, to);
    if let Some(deleted) = deleted {
        query.union(
            UnionType::All,
            inventory_events(table, deleted, true, first_day, to),
        );
    }
    query
}

fn inventory_events(
    table: TableRef,
    at: Expr,
    removed: bool,
    first_day: i64,
    to: i64,
) -> SelectStatement {
    let day: Expr = Func::greatest([at.clone().div(DAY_MS), Expr::val(first_day - 1)]).into();
    let count = Expr::col(Asterisk).count();
    Query::select()
        .expr_as(day, UsageColumn::Day)
        .expr_as(
            if removed {
                Expr::val(0).sub(count)
            } else {
                count
            },
            UsageColumn::Count,
        )
        .from(table)
        .and_where(at.lt(to))
        .group_by_col(UsageColumn::Day)
        .to_owned()
}

fn changes(rows: Vec<QueryResult>) -> Result<BTreeMap<i64, i64>> {
    let mut changes = BTreeMap::new();
    for row in rows {
        *changes.entry(row.try_get("", "day")?).or_default() += row.try_get::<i64>("", "count")?;
    }
    Ok(changes)
}

fn turn_query(from: i64, to: i64) -> SelectStatement {
    let ended_at = Expr::col(turns::Column::EndedAt);
    let date = Func::cust("timezone")
        .args([Expr::val("UTC"), ended_at.clone()])
        .cast_as("date")
        .cast_as("text");
    Query::select()
        .expr_as(date, UsageColumn::Date)
        .expr_as(Expr::col(Asterisk).count(), UsageColumn::Count)
        .from(turns::Entity)
        .and_where(
            ended_at
                .clone()
                .gte(Expr::val(timestamp(from)).cast_as("timestamptz")),
        )
        .and_where(ended_at.lt(Expr::val(timestamp(to)).cast_as("timestamptz")))
        .group_by_col(UsageColumn::Date)
        .to_owned()
}

fn relay_query(from: i64, to: i64) -> SelectStatement {
    let minute = Expr::col(relay::Column::MinuteAt);
    let day = minute.clone().div(DAY_MS);
    // Minute counters already include raw and compacted coturn notifications.
    // Adding raw or archive rows here would count the same traffic twice.
    let mut coturn = Query::select()
        .expr_as(day, UsageColumn::Day)
        .expr_as(
            Expr::col(relay::Column::SentBytes).sum(),
            UsageColumn::Bytes,
        )
        .from(relay::Entity)
        .and_where(minute.clone().gte(from))
        .and_where(minute.lt(to))
        .group_by_col(UsageColumn::Day)
        .to_owned();
    let day = Expr::col(cloudflare::Column::DayStart);
    coturn.union(
        UnionType::All,
        Query::select()
            .expr_as(day.clone().div(DAY_MS), UsageColumn::Day)
            .expr_as(
                Expr::col(cloudflare::Column::EgressBytes).sum(),
                UsageColumn::Bytes,
            )
            .from(cloudflare::Entity)
            .and_where(day.clone().gte(from))
            .and_where(day.clone().lt(to))
            .group_by_col(UsageColumn::Day)
            .to_owned(),
    );
    Query::select()
        .column(UsageColumn::Day)
        .expr_as(
            Expr::col(UsageColumn::Bytes).sum().cast_as("text"),
            UsageColumn::Bytes,
        )
        .from_subquery(coturn, UsageColumn::Daily)
        .group_by_col(UsageColumn::Day)
        .to_owned()
}
