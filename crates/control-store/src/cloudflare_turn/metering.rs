//! Composable freshness projection shared by Team and administrator summaries.
use crate::entities::{
    cp_cloudflare_turn_collector as cloudflare_collector, cp_cloudflare_turn_sources as sources,
    cp_cloudflare_turn_usage as usage, cp_turn_collector as collector,
    cp_turn_settings as settings,
};
use sea_orm::DeriveIden;
use sea_orm::sea_query::{
    Asterisk, CommonTableExpression, Cond, Expr, ExprTrait, Func, Query, SelectStatement,
    WithClause,
};

#[derive(Clone, Copy, DeriveIden)]
enum Meter {
    Coturn,
    Sources,
    Cloudflare,
    Required,
    LastSeenAt,
    GapSince,
    Fresh,
}

fn current_window(now: Expr, start: Expr, end: Expr) -> Cond {
    Cond::all()
        .add(Expr::col((usage::Entity, usage::Column::PeriodStart)).lte(now.clone()))
        .add(Expr::col((usage::Entity, usage::Column::PeriodEnd)).gt(now))
        .add(
            Cond::any()
                .add(start.clone().cast_as("bigint").is_null())
                .add(
                    Cond::all()
                        .add(Expr::col((usage::Entity, usage::Column::PeriodStart)).eq(start))
                        .add(Expr::col((usage::Entity, usage::Column::PeriodEnd)).eq(end)),
                ),
        )
}

pub(super) fn incomplete_usage() -> Cond {
    Cond::any()
        .add(Expr::col((usage::Entity, usage::Column::CollectedAt)).is_null())
        .add(
            Expr::col((usage::Entity, usage::Column::CollectedAt)).lt(Expr::col((
                usage::Entity,
                usage::Column::ExpiresAt,
            ))
            .add(300_000)),
        )
        .add(
            Expr::col((usage::Entity, usage::Column::QueryEnd))
                .lt(Expr::col((usage::Entity, usage::Column::ExpiresAt))),
        )
}

pub(crate) fn query(team: Expr, now: Expr, start: Expr, end: Expr) -> SelectStatement {
    let coturn_required = Query::select()
        .expr(
            Func::cust("jsonb_array_length")
                .arg(Expr::col(settings::Column::Urls))
                .gt(0),
        )
        .from(settings::Entity)
        .and_where(Expr::col(settings::Column::Singleton))
        .to_owned();
    let coturn = Query::select()
        .column((collector::Entity, Asterisk))
        .expr_as(
            Func::coalesce([coturn_required.into(), Expr::val(true)]),
            Meter::Required,
        )
        .from(collector::Entity)
        .and_where(Expr::col(collector::Column::Singleton))
        .to_owned();
    let same_source = Expr::col((usage::Entity, usage::Column::Identifier))
        .eq(Expr::col((sources::Entity, sources::Column::Identifier)));
    let current = Query::select()
        .expr(Expr::col((usage::Entity, usage::Column::CollectedAt)).max())
        .from(usage::Entity)
        .and_where(same_source.clone())
        .cond_where(current_window(now.clone(), start.clone(), end.clone()))
        .to_owned();
    // A recently collected contiguous prior period can bridge the first two
    // minutes of a rollover while the collector writes the new period's snapshot.
    let previous = Query::select()
        .expr(Expr::col((usage::Entity, usage::Column::CollectedAt)).max())
        .from(usage::Entity)
        .and_where(same_source.clone())
        .and_where(Expr::col((usage::Entity, usage::Column::PeriodEnd)).eq(start.clone()))
        .and_where(Expr::col((sources::Entity, sources::Column::ExpiresAt)).gt(now.clone()))
        .and_where(start.clone().gt(now.clone().sub(120_000)))
        .and_where(start.clone().lte(now.clone()))
        .and_where(
            Expr::col((usage::Entity, usage::Column::CollectedAt)).gt(now.clone().sub(120_000)),
        )
        .and_where(
            Expr::col((usage::Entity, usage::Column::QueryEnd)).gte(start.clone().sub(120_000)),
        )
        .to_owned();
    let unfinished = Query::select()
        .expr(Expr::val(1))
        .from(usage::Entity)
        .and_where(same_source)
        .cond_where(current_window(now.clone(), start, end))
        .cond_where(incomplete_usage())
        .to_owned();
    let source_rows = Query::select()
        .column(sources::Column::CreatedAt)
        .expr_as(
            Func::coalesce([Expr::from(current), Expr::from(previous)]),
            Meter::LastSeenAt,
        )
        .from(sources::Entity)
        .cond_where(
            Cond::any()
                .add(team.clone().cast_as("bigint").is_null())
                .add(Expr::col(sources::Column::TeamId).eq(team)),
        )
        .cond_where(
            Cond::any()
                .add(Expr::col(sources::Column::ExpiresAt).gt(now.clone()))
                .add(Expr::exists(unfinished)),
        )
        .to_owned();
    let cloudflare = Query::select()
        .from(Meter::Sources)
        .expr_as(Expr::col(Meter::LastSeenAt).min(), Meter::LastSeenAt)
        .expr_as(
            Func::coalesce([
                Func::cust("bool_and")
                    .arg(
                        Expr::col(sources::Column::CreatedAt)
                            .gt(now.clone().sub(120_000))
                            .or(Func::coalesce([
                                Expr::col(Meter::LastSeenAt).gt(now.clone().sub(120_000)),
                                Expr::val(false),
                            ])),
                    )
                    .into(),
                Expr::val(true),
            ]),
            Meter::Fresh,
        )
        .expr_as(Expr::col(Asterisk).count().gt(0), Meter::Required)
        .to_owned();
    let cloudflare_gap = Query::select()
        .column(cloudflare_collector::Column::GapSince)
        .from(cloudflare_collector::Entity)
        .and_where(Expr::col(cloudflare_collector::Column::Singleton))
        .to_owned();
    let with = WithClause::new()
        .cte(
            CommonTableExpression::new()
                .table_name(Meter::Coturn)
                .query(coturn)
                .to_owned(),
        )
        .cte(
            CommonTableExpression::new()
                .table_name(Meter::Sources)
                .query(source_rows)
                .to_owned(),
        )
        .cte(
            CommonTableExpression::new()
                .table_name(Meter::Cloudflare)
                .query(cloudflare)
                .to_owned(),
        )
        .to_owned();
    Query::select()
        .with_cte(with)
        .from(Meter::Coturn)
        .cross_join(Meter::Cloudflare)
        .expr_as(
            Func::least([
                Expr::case(
                    Expr::col((Meter::Coturn, Meter::Required)),
                    Expr::col((Meter::Coturn, Meter::LastSeenAt)),
                )
                .finally(Option::<i64>::None)
                .into(),
                Expr::case(
                    Expr::col((Meter::Cloudflare, Meter::Required)),
                    Expr::col((Meter::Cloudflare, Meter::LastSeenAt)),
                )
                .finally(Option::<i64>::None)
                .into(),
            ]),
            Meter::LastSeenAt,
        )
        .expr_as(
            Func::least([
                Expr::case(
                    Expr::col((Meter::Coturn, Meter::Required)),
                    Expr::col((Meter::Coturn, Meter::GapSince)),
                )
                .finally(Option::<i64>::None)
                .into(),
                Expr::case(
                    Expr::col((Meter::Cloudflare, Meter::Required)),
                    cloudflare_gap,
                )
                .finally(Option::<i64>::None)
                .into(),
            ]),
            Meter::GapSince,
        )
        .expr_as(
            Expr::col((Meter::Coturn, Meter::Required))
                .not()
                .or(Func::coalesce([
                    Expr::col((Meter::Coturn, Meter::LastSeenAt)).gt(now.sub(60_000)),
                    Expr::val(false),
                ]))
                .and(Expr::col((Meter::Cloudflare, Meter::Fresh))),
            Meter::Fresh,
        )
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::cp_billing_profiles as profiles;
    use crate::{ControlStore, cloudflare_turn::CloudflareTurnConfig, now_ms};
    use sea_orm::{ConnectionTrait, Database};

    #[tokio::test]
    #[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
    async fn rollover_grace_ends_at_two_minutes_with_the_production_query() {
        let base = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let admin = Database::connect(&base).await.unwrap();
        let schema = format!("metering_query_{}", uuid::Uuid::new_v4().simple());
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
        store.seed_turn_settings(&[]).await.unwrap();
        let owner = store
            .verified_user("owner@metering-query.test", "Owner")
            .await
            .unwrap();
        let team = store.create_team(&owner.id, "Team").await.unwrap();
        let team_id: i64 = team.id.parse().unwrap();
        store.billing_profile(&team.id).await.unwrap();
        let now = now_ms();
        let start = now - 20_000;
        store
            .database()
            .execute(
                Query::update()
                    .table(profiles::Entity)
                    .value(profiles::Column::PeriodAnchor, start)
                    .and_where(Expr::col(profiles::Column::TeamId).eq(team_id)),
            )
            .await
            .unwrap();
        let (_, end) = crate::billing::period_at(start, now);
        let identifier = store
            .prepare_cloudflare_turn_usage(
                &team.id,
                &CloudflareTurnConfig {
                    enabled: true,
                    account_id: "a".repeat(32),
                    key_id: "b".repeat(32),
                    api_token: "api-token".into(),
                    analytics_token: "analytics-token".into(),
                },
                now + 3_600_000,
            )
            .await
            .unwrap();
        store
            .database()
            .execute(
                Query::update()
                    .table(sources::Entity)
                    .value(sources::Column::CreatedAt, now - 180_000)
                    .and_where(Expr::col(sources::Column::Identifier).eq(identifier.as_str())),
            )
            .await
            .unwrap();
        store
            .database()
            .execute(
                Query::insert()
                    .into_table(usage::Entity)
                    .columns([
                        usage::Column::Identifier,
                        usage::Column::PeriodStart,
                        usage::Column::PeriodEnd,
                        usage::Column::ExpiresAt,
                        usage::Column::QueryEnd,
                        usage::Column::CollectedAt,
                    ])
                    .values_panic([
                        identifier.into(),
                        (start - 2_592_000_000_i64).into(),
                        start.into(),
                        start.into(),
                        (start - 1000).into(),
                        (now - 1000).into(),
                    ]),
            )
            .await
            .unwrap();
        for (at, fresh) in [(start + 119_999, true), (start + 120_000, false)] {
            let row = store
                .database()
                .query_one(&query(
                    Expr::val(Some(team_id)),
                    Expr::val(at),
                    Expr::val(Some(start)),
                    Expr::val(Some(end)),
                ))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(row.try_get::<bool>("", "fresh").unwrap(), fresh);
        }
        store.close().await.unwrap();
        admin
            .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
            .await
            .unwrap();
        admin.close().await.unwrap();
    }
}
