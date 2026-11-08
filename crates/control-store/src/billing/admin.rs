use super::{period_at, profile, summary_value, usage_query};
use crate::entities::{
    cp_billing_profiles as profiles, cp_members as members, cp_teams as teams, cp_users as users,
};
use crate::search::escape_like;
use crate::{ControlStore, Error, Result, now_ms, resource_id};
use sea_orm::ConnectionTrait;
use sea_orm::DeriveIden;
use sea_orm::sea_query::{
    Asterisk, Cond, Expr, ExprTrait, Func, JoinType, OnConflict, Order, Query,
    extension::postgres::PgExpr,
};

#[derive(Clone, Copy, DeriveIden)]
enum Period {
    Rows,
    TeamId,
    StartAt,
    EndAt,
}
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminBillingPage {
    pub teams: Vec<Value>,
    pub next_cursor: Option<String>,
}

impl ControlStore {
    /// Return one Team page with a fixed number of SQL round trips.
    pub async fn admin_billing_teams(
        &self,
        user_id: &str,
        cursor: Option<&str>,
        search: Option<&str>,
        limit: usize,
    ) -> Result<AdminBillingPage> {
        if !self.is_site_admin(user_id).await? {
            return Err(Error::Forbidden);
        }
        let after = cursor.map(resource_id).transpose()?.unwrap_or(0);
        let limit = limit.clamp(1, 100);
        let mut teams_query = Query::select()
            .column(teams::Column::Id)
            .from(teams::Entity)
            .and_where(Expr::col(teams::Column::Id).gt(after))
            .order_by(teams::Column::Id, Order::Asc)
            .limit((limit + 1) as u64)
            .to_owned();
        if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
            let pattern = format!("%{}%", escape_like(search));
            let owner = Query::select()
                .expr(Expr::val(1))
                .from(members::Entity)
                .join(
                    JoinType::InnerJoin,
                    users::Entity,
                    Expr::col((users::Entity, users::Column::Id))
                        .eq(Expr::col((members::Entity, members::Column::UserId))),
                )
                .and_where(
                    Expr::col((members::Entity, members::Column::TeamId))
                        .eq(Expr::col((teams::Entity, teams::Column::Id))),
                )
                .and_where(Expr::col((members::Entity, members::Column::Role)).eq("owner"))
                .cond_where(
                    Cond::any()
                        .add(Expr::col((users::Entity, users::Column::Name)).ilike(pattern.clone()))
                        .add(
                            Expr::col((users::Entity, users::Column::Email)).ilike(pattern.clone()),
                        ),
                )
                .to_owned();
            teams_query.cond_where(
                Cond::any()
                    .add(Expr::col(teams::Column::Name).ilike(pattern))
                    .add(Expr::exists(owner)),
            );
        }
        let mut ids = self
            .db
            .query_all(&teams_query)
            .await?
            .into_iter()
            .map(|row| row.try_get::<i64>("", "id"))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = ids.len() > limit;
        ids.truncate(limit);
        let next_cursor = has_more.then(|| ids[limit - 1].to_string());
        if ids.is_empty() {
            return Ok(AdminBillingPage {
                teams: Vec::new(),
                next_cursor,
            });
        }
        let now = now_ms();
        self.db
            .execute(
                Query::insert()
                    .into_table(profiles::Entity)
                    .columns([profiles::Column::TeamId, profiles::Column::PeriodAnchor])
                    .select_from(
                        Query::select()
                            .column(teams::Column::Id)
                            .expr(Expr::val(now))
                            .from(teams::Entity)
                            .and_where(Expr::col(teams::Column::Id).is_in(ids.clone()))
                            .to_owned(),
                    )
                    .expect("two selected profile columns")
                    .on_conflict(
                        OnConflict::column(profiles::Column::TeamId)
                            .do_nothing()
                            .to_owned(),
                    ),
            )
            .await?;
        let profiles = self
            .db
            .query_all(
                Query::select()
                    .column(Asterisk)
                    .from(profiles::Entity)
                    .and_where(Expr::col(profiles::Column::TeamId).is_in(ids))
                    .order_by(profiles::Column::TeamId, Order::Asc),
            )
            .await?
            .into_iter()
            .map(profile)
            .collect::<Result<Vec<_>>>()?;
        if profiles.is_empty() {
            return Ok(AdminBillingPage {
                teams: Vec::new(),
                next_cursor,
            });
        }
        let periods = profiles
            .iter()
            .map(|p| {
                let (start, end) = period_at(p.period_anchor, now);
                Ok((resource_id(&p.team_id)?, start, end))
            })
            .collect::<Result<Vec<_>>>()?;
        let period_rows = Query::select()
            .expr_as(Expr::col(("periods", "column1")), Period::TeamId)
            .expr_as(Expr::col(("periods", "column2")), Period::StartAt)
            .expr_as(Expr::col(("periods", "column3")), Period::EndAt)
            .from_values(periods, "periods")
            .to_owned();
        let team = Expr::col((Period::Rows, Period::TeamId));
        let start = Expr::col((Period::Rows, Period::StartAt));
        let end = Expr::col((Period::Rows, Period::EndAt));
        // The same composable query serves a single Team and every row in this
        // page, preserving its correlated period and single statement snapshot.
        let meter = crate::cloudflare_turn::metering::query(
            team.clone(),
            Expr::val(now),
            start.clone(),
            end.clone(),
        );
        let usage = self
            .db
            .query_all(
                usage_query(team.clone(), start, end)
                    .column((Period::Rows, Period::TeamId))
                    .column((teams::Entity, teams::Column::Name))
                    .expr_as(
                        Func::cust("jsonb_build_object").args([
                            Expr::val("id"),
                            Expr::col((users::Entity, users::Column::Id)),
                            Expr::val("name"),
                            Expr::col((users::Entity, users::Column::Name)),
                            Expr::val("email"),
                            Expr::col((users::Entity, users::Column::Email)),
                        ]),
                        "owner",
                    )
                    .columns([
                        ("meter", "last_seen_at"),
                        ("meter", "gap_since"),
                        ("meter", "fresh"),
                    ])
                    .from_subquery(period_rows, Period::Rows)
                    .join(
                        JoinType::InnerJoin,
                        teams::Entity,
                        Expr::col((teams::Entity, teams::Column::Id)).eq(team),
                    )
                    .join(
                        JoinType::InnerJoin,
                        members::Entity,
                        Expr::col((members::Entity, members::Column::TeamId))
                            .eq(Expr::col((teams::Entity, teams::Column::Id)))
                            .and(Expr::col((members::Entity, members::Column::Role)).eq("owner")),
                    )
                    .join(
                        JoinType::InnerJoin,
                        users::Entity,
                        Expr::col((users::Entity, users::Column::Id))
                            .eq(Expr::col((members::Entity, members::Column::UserId))),
                    )
                    .join_lateral(JoinType::InnerJoin, meter, "meter", Expr::val(true))
                    .order_by((Period::Rows, Period::TeamId), Order::Asc),
            )
            .await?;
        let mut by_id = profiles
            .into_iter()
            .map(|p| (p.team_id.clone(), p))
            .collect::<std::collections::HashMap<_, _>>();
        let mut teams = Vec::with_capacity(usage.len());
        for row in usage {
            let id = row.try_get::<i64>("", "team_id")?.to_string();
            if let Some(p) = by_id.remove(&id) {
                teams.push(json!({"id":id,"name":row.try_get::<String>("", "name")?,"owner":row.try_get::<Value>("", "owner")?,"billing":summary_value(p,&row,&row,self.hosted,now)?}));
            }
        }
        Ok(AdminBillingPage { teams, next_cursor })
    }
}
