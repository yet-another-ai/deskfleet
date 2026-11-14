use super::CloudflareTurnUsageQuery;
use crate::{Error, Result, entities::cp_cloudflare_turn_daily as daily};
use sea_orm::ConnectionTrait;
use sea_orm::sea_query::{Expr, ExprTrait, OnConflict, Query};

pub(super) const DAY_MS: i64 = 86_400_000;

/// An exact integer sum of the provider's hourly estimates for a UTC day.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudflareTurnDailyUsage {
    pub day_start: i64,
    pub egress_bytes: i64,
}

pub(super) fn validate(
    query: &CloudflareTurnUsageQuery,
    days: &[CloudflareTurnDailyUsage],
) -> Result<()> {
    let start = query.period_start.div_euclid(DAY_MS) * DAY_MS;
    let duration = query
        .query_end
        .checked_sub(start)
        .filter(|duration| *duration > 0 && *duration <= 32 * DAY_MS);
    let Some(duration) = duration else {
        return Err(Error::Invalid(
            "invalid Cloudflare TURN daily usage snapshot",
        ));
    };
    let expected = (duration + DAY_MS - 1) / DAY_MS;
    if usize::try_from(expected).ok() != Some(days.len()) {
        return Err(Error::Invalid(
            "invalid Cloudflare TURN daily usage snapshot",
        ));
    }
    for (index, day) in (0..expected).zip(days) {
        if day.egress_bytes < 0 || day.day_start != start + index * DAY_MS {
            return Err(Error::Invalid(
                "invalid Cloudflare TURN daily usage snapshot",
            ));
        }
    }
    Ok(())
}

pub(super) async fn save(
    db: &impl ConnectionTrait,
    query: &CloudflareTurnUsageQuery,
    days: &[CloudflareTurnDailyUsage],
    now: i64,
) -> Result<()> {
    if days.is_empty() {
        return Ok(());
    }
    let mut insert = Query::insert();
    insert.into_table(daily::Entity).columns([
        daily::Column::Identifier,
        daily::Column::DayStart,
        daily::Column::EgressBytes,
        daily::Column::QueryEnd,
        daily::Column::CollectedAt,
    ]);
    for day in days {
        insert.values_panic([
            query.identifier.as_str().into(),
            day.day_start.into(),
            day.egress_bytes.into(),
            std::cmp::min(query.query_end, day.day_start + DAY_MS).into(),
            now.into(),
        ]);
    }
    insert.on_conflict(
        OnConflict::columns([daily::Column::Identifier, daily::Column::DayStart])
            .update_columns([
                daily::Column::EgressBytes,
                daily::Column::QueryEnd,
                daily::Column::CollectedAt,
            ])
            // Adjacent or replaced billing windows can overlap the same UTC day.
            // Both query from midnight; never replace a longer prefix with a shorter one.
            .action_and_where(
                Expr::col(("excluded", daily::Column::QueryEnd))
                    .gte(Expr::col((daily::Entity, daily::Column::QueryEnd))),
            )
            .to_owned(),
    );
    db.execute(&insert).await?;
    Ok(())
}
