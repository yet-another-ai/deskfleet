//! Team analytics over synchronized turn snapshots. The daemon retains ownership
//! of execution and usage reporting; this read model does not infer token costs.
mod query;
mod types;

use std::collections::BTreeMap;

use chrono::{Datelike, Days, NaiveDate};
use serde_json::{Value, json};

use crate::{ControlStore, Error, Result, now_ms, policies::TeamAction, timestamp};
use types::{Bucket, Counts, Day, Group, Session, Totals, Turn};

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
const SESSION_LIMIT: usize = 100;

#[derive(Clone, Copy)]
enum Period {
    Day,
    Week,
    Month,
    All,
}

impl Period {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "24h" => Ok(Self::Day),
            "7d" => Ok(Self::Week),
            "30d" => Ok(Self::Month),
            "all" => Ok(Self::All),
            _ => Err(Error::Invalid("invalid usage period")),
        }
    }
}

fn parse_date(value: &str) -> Result<NaiveDate> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| Error::Invalid("invalid usage date"))?;
    if value.len() != 10 || date.year() == 0 || date.to_string() != value {
        return Err(Error::Invalid("invalid usage date"));
    }
    Ok(date)
}

impl ControlStore {
    /// Aggregate a Team's reported AI tokens and reporting coverage.
    ///
    /// Missing usage remains uncovered, while a reported zero counts as covered.
    /// Cache and thought tokens are optional breakdowns, not additions to totals.
    ///
    /// # Errors
    /// Returns an error for denied access, invalid ranges/zones, or storage errors.
    pub async fn team_ai_usage(
        &self,
        user_id: &str,
        team_id: &str,
        period: &str,
        time_zone: &str,
    ) -> Result<Value> {
        self.authorize_team(user_id, team_id, TeamAction::ReadUsage)
            .await?;
        let selection = Period::parse(period)?;
        self.usage_time_zone(time_zone).await?;
        let now = now_ms();
        let today = self.usage_today(time_zone, now).await?;
        let today_date = parse_date(&today)?;
        let heatmap_date = today_date
            .checked_sub_days(Days::new(370))
            .ok_or(Error::Invalid("invalid usage date"))?;
        let heatmap_calendar = self
            .usage_calendar(time_zone, &heatmap_date.to_string(), &today)
            .await?;
        let heatmap_from = heatmap_calendar
            .first()
            .ok_or(Error::Invalid("invalid usage date"))?
            .start;
        let turns = self
            .usage_turns(
                team_id,
                time_zone,
                (!matches!(selection, Period::All)).then_some(heatmap_from),
                now,
            )
            .await?;
        let start_date = match selection {
            Period::Day => today_date,
            Period::Week => today_date
                .checked_sub_days(Days::new(6))
                .unwrap_or(today_date),
            Period::Month => today_date
                .checked_sub_days(Days::new(29))
                .unwrap_or(today_date),
            Period::All => turns
                .first()
                .map(|turn| parse_date(&turn.date))
                .transpose()?
                .unwrap_or(today_date),
        };
        let calendar = self
            .usage_calendar(time_zone, &start_date.to_string(), &today)
            .await?;
        let from = if matches!(selection, Period::Day) {
            now.saturating_sub(DAY_MS)
        } else {
            calendar
                .first()
                .ok_or(Error::Invalid("invalid usage date"))?
                .start
        };
        let mut buckets: BTreeMap<i64, Bucket> = if matches!(selection, Period::Day) {
            (from.div_euclid(HOUR_MS)..=now.div_euclid(HOUR_MS))
                .map(|hour| {
                    let start = hour.saturating_mul(HOUR_MS);
                    (
                        start,
                        Bucket {
                            start: timestamp(start),
                            ..Bucket::default()
                        },
                    )
                })
                .collect()
        } else {
            calendar
                .into_iter()
                .map(|day| {
                    (
                        day.start,
                        Bucket {
                            start: timestamp(day.start),
                            ..Bucket::default()
                        },
                    )
                })
                .collect()
        };
        let mut heatmap: BTreeMap<String, Day> = heatmap_calendar
            .into_iter()
            .map(|day| {
                (
                    day.date.clone(),
                    Day {
                        date: day.date,
                        counts: Counts::default(),
                    },
                )
            })
            .collect();
        let mut totals = Totals::default();
        let mut models = BTreeMap::new();
        let mut members = BTreeMap::new();
        for turn in &turns {
            if let Some(day) = heatmap.get_mut(&turn.date) {
                day.counts.add(turn.usage.as_ref());
            }
            if turn.ended_at < from {
                continue;
            }
            totals.add(turn.usage.as_ref());
            add_group(&mut models, &turn.model_id, &turn.model_name, turn);
            add_group(&mut members, &turn.member_id, &turn.member_name, turn);
            let start = if matches!(selection, Period::Day) {
                turn.ended_at.div_euclid(HOUR_MS).saturating_mul(HOUR_MS)
            } else {
                turn.day_start
            };
            if let Some(bucket) = buckets.get_mut(&start) {
                bucket.counts.add(turn.usage.as_ref());
                let count = turn.usage.as_ref().map_or(0, types::Usage::total_tokens);
                add_count(&mut bucket.models, &turn.model_id, count);
                add_count(&mut bucket.members, &turn.member_id, count);
            }
        }
        Ok(json!({
            "period": period,
            "timeZone": time_zone,
            "from": timestamp(from),
            "to": timestamp(now),
            "lastSyncedAt": self.usage_last_synced(team_id).await?.map(timestamp),
            "totals": totals,
            "buckets": buckets.into_values().collect::<Vec<_>>(),
            "heatmap": heatmap.into_values().collect::<Vec<_>>(),
            "models": sorted_groups(models),
            "members": sorted_groups(members),
        }))
    }

    /// Return the 100 Sessions with the most reported tokens on a local date.
    ///
    /// # Errors
    /// Returns an error for denied access, invalid dates/zones, or storage errors.
    pub async fn team_ai_usage_sessions(
        &self,
        user_id: &str,
        team_id: &str,
        date: &str,
        time_zone: &str,
    ) -> Result<Value> {
        self.authorize_team(user_id, team_id, TeamAction::ReadUsage)
            .await?;
        let day = parse_date(date)?;
        let next = day.succ_opt().ok_or(Error::Invalid("invalid usage date"))?;
        self.usage_time_zone(time_zone).await?;
        let calendar = self
            .usage_calendar(time_zone, date, &next.to_string())
            .await?;
        let [start, end] = calendar.as_slice() else {
            return Err(Error::Invalid("invalid usage date"));
        };
        let turns = self
            .usage_turns(
                team_id,
                time_zone,
                Some(start.start),
                end.start.min(now_ms()),
            )
            .await?;
        let mut sessions = BTreeMap::new();
        for turn in turns {
            let key = (turn.machine_id.clone(), turn.session_id.clone());
            let session = sessions.entry(key).or_insert_with(|| Session {
                machine_id: turn.machine_id,
                machine_name: turn.machine_name,
                session_id: turn.session_id,
                title: turn.title,
                totals: Totals::default(),
            });
            session.totals.add(turn.usage.as_ref());
        }
        let mut sessions: Vec<Session> = sessions.into_values().collect();
        sessions.sort_by(|a, b| {
            b.totals
                .counts
                .total_tokens
                .cmp(&a.totals.counts.total_tokens)
                .then_with(|| a.machine_id.cmp(&b.machine_id))
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        let truncated = sessions.len() > SESSION_LIMIT;
        sessions.truncate(SESSION_LIMIT);
        Ok(
            json!({"date": date, "timeZone": time_zone, "sessions": sessions, "truncated": truncated}),
        )
    }
}

fn add_group(groups: &mut BTreeMap<String, Group>, id: &str, name: &str, turn: &Turn) {
    let group = groups.entry(id.to_owned()).or_insert_with(|| Group {
        id: id.to_owned(),
        name: name.to_owned(),
        counts: Counts::default(),
    });
    group.counts.add(turn.usage.as_ref());
}

fn add_count(counts: &mut BTreeMap<String, u64>, id: &str, count: u64) {
    let total = counts.entry(id.to_owned()).or_default();
    *total = total.saturating_add(count);
}

fn sorted_groups(groups: BTreeMap<String, Group>) -> Vec<Group> {
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by(|a, b| {
        b.counts
            .total_tokens
            .cmp(&a.counts.total_tokens)
            .then_with(|| a.id.cmp(&b.id))
    });
    groups
}
