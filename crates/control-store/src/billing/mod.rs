//! Team-owned subscriptions, manual overrides, and authoritative usage admission.
mod admin;
mod admissions;
mod analytics;
mod payments;
mod period;

pub use admin::AdminBillingPage;
pub use analytics::{BillingAnalyticsDelivery, BillingAnalyticsEvent};
pub use payments::{CheckoutAttempt, PaymentEvent, SubscriptionProjection};
pub use period::period_at;

use crate::entities::{
    cp_billing_profiles as profiles, cp_machine_registrations as registrations,
    cp_members as members, cp_peers as peers, cp_site_admins as admins, cp_site_audit as audit,
    cp_teams as teams, cp_turn_collector as collector,
};
use crate::{ControlStore, Error, Result, now_ms, one_query, resource_id, timestamp};
use sea_orm::sea_query::{
    Asterisk, Cond, Expr, ExprTrait, Func, LockType, OnConflict, Query, SelectStatement,
};
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Plan {
    Free,
    Go,
    Pro,
    Enterprise,
    SelfHosted,
}

impl Plan {
    pub fn paid(value: &str) -> Result<Self> {
        match value {
            "go" => Ok(Self::Go),
            "pro" => Ok(Self::Pro),
            _ => Err(Error::Invalid("unknown subscription plan")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Go => "go",
            Self::Pro => "pro",
            Self::Enterprise => "enterprise",
            Self::SelfHosted => "selfHosted",
        }
    }
    pub fn limits(self) -> Limits {
        Limits {
            max_active_sessions: (self == Self::Free).then_some(3),
            max_turns_per_session: (self == Self::Free).then_some(30),
            max_members: (self == Self::Free).then_some(3),
            turn_bytes: match self {
                Self::Free => Some(0),
                Self::Go => Some(2_147_483_648),
                Self::Pro => Some(21_474_836_480),
                _ => None,
            },
            team_turn_servers: matches!(self, Self::Pro | Self::Enterprise | Self::SelfHosted),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayDeniedReason {
    FreePlan,
    TurnQuotaExhausted,
    MeteringUnavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_active_sessions: Option<i64>,
    pub max_turns_per_session: Option<i64>,
    pub max_members: Option<i64>,
    pub turn_bytes: Option<i64>,
    /// A Team's own TURN server replaces the site relay without consuming allowance.
    pub team_turn_servers: bool,
}

#[derive(Clone, Debug)]
pub struct BillingProfile {
    pub team_id: String,
    pub customer_id: Option<String>,
    pub subscription_id: Option<String>,
    pub plan: Option<String>,
    pub subscription_status: Option<String>,
    pub paid_through: Option<i64>,
    pub period_anchor: i64,
    pub cancel_at_period_end: bool,
    pub enterprise: bool,
    pub grant_plan: Option<String>,
    pub grant_expires_at: Option<i64>,
}

impl BillingProfile {
    pub fn effective_plan(&self, hosted: bool, now: i64) -> Plan {
        if !hosted {
            return Plan::SelfHosted;
        }
        if self.grant_expires_at.is_none_or(|end| now < end) {
            match self.grant_plan.as_deref() {
                Some("free") => return Plan::Free,
                Some("go") => return Plan::Go,
                Some("pro") => return Plan::Pro,
                Some("enterprise") => return Plan::Enterprise,
                _ => {}
            }
        }
        if self.paid_through.is_some_and(|end| now < end) {
            return self
                .plan
                .as_deref()
                .and_then(|value| Plan::paid(value).ok())
                .unwrap_or(Plan::Free);
        }
        Plan::Free
    }
}

fn profile(row: QueryResult) -> Result<BillingProfile> {
    Ok(BillingProfile {
        team_id: row.try_get::<i64>("", "team_id")?.to_string(),
        customer_id: row.try_get("", "customer_id")?,
        subscription_id: row.try_get("", "subscription_id")?,
        plan: row.try_get("", "plan")?,
        subscription_status: row.try_get("", "subscription_status")?,
        paid_through: row.try_get("", "paid_through")?,
        period_anchor: row.try_get("", "period_anchor")?,
        cancel_at_period_end: row.try_get("", "cancel_at_period_end")?,
        enterprise: row.try_get("", "enterprise")?,
        grant_plan: row.try_get("", "grant_plan")?,
        grant_expires_at: row.try_get("", "grant_expires_at")?,
    })
}

fn summary_value(
    p: BillingProfile,
    usage: &QueryResult,
    meter: &QueryResult,
    hosted: bool,
    now: i64,
) -> Result<Value> {
    let plan = p.effective_plan(hosted, now);
    let (start, end) = period_at(p.period_anchor, now);
    let last_seen = meter.try_get::<Option<i64>>("", "last_seen_at")?;
    Ok(json!({
        "plan":plan,"limits":plan.limits(),"enterpriseOverride":plan == Plan::Enterprise && p.grant_plan.as_deref() == Some("enterprise"),
        "manualGrant":p.grant_plan.as_ref().filter(|_| p.grant_expires_at.is_none_or(|end| now < end)).map(|grant| json!({"plan":grant,"expiresAt":p.grant_expires_at.map(timestamp)})),
        "usage":{"activeSessionCount":usage.try_get::<i64>("","sessions")?,"memberCount":usage.try_get::<i64>("","members")?,"relayedBytes":usage.try_get::<String>("","bytes")?},
        "period":{"start":timestamp(start),"end":timestamp(end)},"nextResetAt":timestamp(end),
        "metering":{"lastSeenAt":last_seen.map(timestamp),"gapSince":meter.try_get::<Option<i64>>("","gap_since")?.map(timestamp),"fresh":meter.try_get::<bool>("","fresh")?},
        "subscription":p.subscription_id.map(|_|json!({"plan":p.plan,"status":p.subscription_status,"paidThrough":p.paid_through.map(timestamp),"cancelAtPeriodEnd":p.cancel_at_period_end}))
    }))
}

pub(crate) async fn effective_plan(
    db: &impl ConnectionTrait,
    team: i64,
    hosted: bool,
    at: i64,
) -> Result<Plan> {
    if !hosted {
        return Ok(Plan::SelfHosted);
    }
    let row = db
        .query_one(
            Query::select()
                .column(Asterisk)
                .from(profiles::Entity)
                .and_where(Expr::col(profiles::Column::TeamId).eq(team)),
        )
        .await?;
    row.map(profile)
        .transpose()
        .map(|value| value.map_or(Plan::Free, |p| p.effective_plan(true, at)))
}

fn usage_query(team: Expr, start: Expr, end: Expr) -> SelectStatement {
    Query::select()
        .expr_as(
            admissions::occupied_sessions(team.clone())
                .expr(Expr::col(Asterisk).count())
                .and_where(Expr::col((registrations::Entity, registrations::Column::Revoked)).not())
                .to_owned(),
            "sessions",
        )
        .expr_as(
            Query::select()
                .expr(Expr::col(Asterisk).count())
                .from(members::Entity)
                .and_where(Expr::col(members::Column::TeamId).eq(team.clone()))
                .to_owned(),
            "members",
        )
        .expr_as(
            Func::cust("cp_turn_sent_bytes")
                .args([team, start, end])
                .cast_as("text"),
            "bytes",
        )
        .to_owned()
}

impl ControlStore {
    pub async fn billing_profile(&self, team_id: &str) -> Result<BillingProfile> {
        let team = resource_id(team_id)?;
        self.db
            .execute(
                Query::insert()
                    .into_table(profiles::Entity)
                    .columns([profiles::Column::TeamId, profiles::Column::PeriodAnchor])
                    .select_from(
                        Query::select()
                            .column(teams::Column::Id)
                            .expr(Expr::val(now_ms()))
                            .from(teams::Entity)
                            .and_where(Expr::col(teams::Column::Id).eq(team))
                            .to_owned(),
                    )
                    .expect("two selected billing profile columns")
                    .on_conflict(
                        OnConflict::column(profiles::Column::TeamId)
                            .do_nothing()
                            .to_owned(),
                    ),
            )
            .await?;
        profile(
            one_query(
                &self.db,
                Query::select()
                    .column(Asterisk)
                    .from(profiles::Entity)
                    .and_where(Expr::col(profiles::Column::TeamId).eq(team)),
            )
            .await?,
        )
    }

    pub async fn team_entitlements(&self, team_id: &str) -> Result<Value> {
        let p = self.billing_profile(team_id).await?;
        let plan = p.effective_plan(self.hosted, now_ms());
        let limits = plan.limits();
        let valid_until = matches!(plan, Plan::Go | Plan::Pro)
            .then_some(p.paid_through)
            .flatten();
        Ok(
            json!({"plan":plan,"maxTurnsPerSession":limits.max_turns_per_session,"turnLimit":limits.max_turns_per_session,"validUntil":valid_until.map(timestamp),"limits":limits}),
        )
    }

    pub async fn billing_summary(&self, team_id: &str) -> Result<Value> {
        let p = self.billing_profile(team_id).await?;
        let now = now_ms();
        let (start, end) = period_at(p.period_anchor, now);
        let row = one_query(
            &self.db,
            &usage_query(
                Expr::val(resource_id(team_id)?),
                Expr::val(start),
                Expr::val(end),
            ),
        )
        .await?;
        let meter =
            crate::cloudflare_turn::metering(&self.db, Some(resource_id(team_id)?), now).await?;
        summary_value(p, &row, &meter, self.hosted, now)
    }

    pub async fn relay_allowed(&self, team_id: &str) -> Result<bool> {
        Ok(self.relay_denied_reason(team_id).await?.is_none())
    }

    pub async fn relay_denied_reason(&self, team_id: &str) -> Result<Option<RelayDeniedReason>> {
        let profile = self.billing_profile(team_id).await?;
        let now = now_ms();
        let Some(limit) = profile.effective_plan(self.hosted, now).limits().turn_bytes else {
            return Ok(None);
        };
        if limit == 0 {
            return Ok(Some(RelayDeniedReason::FreePlan));
        }
        let (start, end) = period_at(profile.period_anchor, now);
        let meter =
            crate::cloudflare_turn::metering(&self.db, Some(resource_id(team_id)?), now).await?;
        if !meter.try_get::<bool>("", "fresh")? {
            return Ok(Some(RelayDeniedReason::MeteringUnavailable));
        }
        let allowed: bool = one_query(
            &self.db,
            Query::select().expr_as(
                Func::cust("cp_turn_sent_bytes")
                    .args([
                        Expr::val(resource_id(team_id)?),
                        Expr::val(start),
                        Expr::val(end),
                    ])
                    .lt(limit),
                "allowed",
            ),
        )
        .await?
        .try_get("", "allowed")?;
        Ok((!allowed).then_some(RelayDeniedReason::TurnQuotaExhausted))
    }

    pub async fn save_peer_relay_decision(&self, peer_id: &str, allowed: bool) -> Result<()> {
        self.db
            .execute(
                Query::update()
                    .table(peers::Entity)
                    .value(peers::Column::RelayAllowed, allowed)
                    .and_where(Expr::col(peers::Column::Id).eq(peer_id)),
            )
            .await?;
        Ok(())
    }
    pub async fn peer_relay_decision(&self, peer_id: &str) -> Result<bool> {
        Ok(one_query(
            &self.db,
            Query::select()
                .column(peers::Column::RelayAllowed)
                .from(peers::Entity)
                .and_where(Expr::col(peers::Column::Id).eq(peer_id)),
        )
        .await?
        .try_get("", "relay_allowed")?)
    }

    pub async fn set_manual_grant(
        &self,
        actor: &str,
        team_id: &str,
        plan: Option<&str>,
        expires_at: Option<i64>,
        reason: &str,
    ) -> Result<()> {
        if plan.is_some_and(|p| !matches!(p, "free" | "go" | "pro" | "enterprise"))
            || (plan.is_none() && expires_at.is_some())
        {
            return Err(Error::Invalid("invalid manual grant"));
        }
        if reason.trim().is_empty() || reason.len() > 2000 {
            return Err(Error::Invalid("a reason of at most 2000 bytes is required"));
        }
        if expires_at.is_some_and(|end| end <= now_ms()) {
            return Err(Error::Invalid("grant expiry must be in the future"));
        }
        if !self.hosted {
            return Err(Error::Invalid(
                "self-hosted installations already have unlimited allowances",
            ));
        }
        let tx = self.db.begin().await?;
        if tx
            .query_one(
                Query::select()
                    .column(admins::Column::UserId)
                    .from(admins::Entity)
                    .and_where(Expr::col(admins::Column::UserId).eq(actor))
                    .lock(LockType::Share),
            )
            .await?
            .is_none()
        {
            return Err(Error::Forbidden);
        }
        let team = resource_id(team_id)?;
        one_query(
            &tx,
            Query::select()
                .column(teams::Column::Id)
                .from(teams::Entity)
                .and_where(Expr::col(teams::Column::Id).eq(team))
                .lock(LockType::Update),
        )
        .await?;
        tx.execute(
            Query::insert()
                .into_table(profiles::Entity)
                .columns([profiles::Column::TeamId, profiles::Column::PeriodAnchor])
                .values_panic([team.into(), now_ms().into()])
                .on_conflict(
                    OnConflict::column(profiles::Column::TeamId)
                        .do_nothing()
                        .to_owned(),
                ),
        )
        .await?;
        let before = one_query(
            &tx,
            Query::select()
                .columns([
                    profiles::Column::GrantPlan,
                    profiles::Column::GrantExpiresAt,
                ])
                .from(profiles::Entity)
                .and_where(Expr::col(profiles::Column::TeamId).eq(team))
                .lock(LockType::Update),
        )
        .await?;
        let before_plan: Option<String> = before.try_get("", "grant_plan")?;
        let before_expiry: Option<i64> = before.try_get("", "grant_expires_at")?;
        if before_plan.as_deref() != plan || before_expiry != expires_at {
            tx.execute(
                Query::update()
                    .table(profiles::Entity)
                    .value(profiles::Column::GrantPlan, plan.map(str::to_owned))
                    .value(profiles::Column::GrantExpiresAt, expires_at)
                    .value(profiles::Column::Enterprise, plan == Some("enterprise"))
                    .and_where(Expr::col(profiles::Column::TeamId).eq(team)),
            )
            .await?;
            tx.execute(Query::insert().into_table(audit::Entity).columns([
                audit::Column::ActorUserId, audit::Column::Source, audit::Column::Action,
                audit::Column::BeforeValue, audit::Column::AfterValue, audit::Column::OccurredAt,
            ]).values_panic([
                actor.into(), "user".into(), "enterprise.update".into(),
                json!({"teamId":team_id,"plan":before_plan,"expiresAt":before_expiry}).into(),
                json!({"teamId":team_id,"plan":plan,"expiresAt":expires_at,"reason":reason.trim()}).into(),
                now_ms().into(),
            ])).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Claim ownership before connecting; a lease alone is not evidence of healthy collection.
    pub async fn claim_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self
            .db
            .execute(
                Query::update()
                    .table(collector::Entity)
                    .value(
                        collector::Column::GapSince,
                        Expr::case(
                            Cond::all()
                                .add(Expr::col(collector::Column::Owner).is_not_null())
                                .add(
                                    Cond::any()
                                        .add(Expr::col(collector::Column::LeaseUntil).is_null())
                                        .add(Expr::col(collector::Column::LeaseUntil).lt(now)),
                                ),
                            Func::coalesce([
                                Expr::col(collector::Column::GapSince),
                                Expr::col(collector::Column::LastSeenAt),
                                Expr::val(now),
                            ]),
                        )
                        .finally(Expr::col(collector::Column::GapSince)),
                    )
                    .value(collector::Column::Owner, owner)
                    .value(collector::Column::LeaseUntil, now + 45_000)
                    .and_where(Expr::col(collector::Column::Singleton))
                    .cond_where(
                        Cond::any()
                            .add(Expr::col(collector::Column::Owner).eq(owner))
                            .add(Expr::col(collector::Column::LeaseUntil).is_null())
                            .add(Expr::col(collector::Column::LeaseUntil).lt(now)),
                    ),
            )
            .await?
            .rows_affected()
            == 1)
    }
    /// Renew freshness only after a successful ping on the subscribed Redis connection.
    pub async fn heartbeat_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self
            .db
            .execute(
                Query::update()
                    .table(collector::Entity)
                    .value(collector::Column::LeaseUntil, now + 45_000)
                    .value(collector::Column::LastSeenAt, now)
                    .and_where(Expr::col(collector::Column::Singleton))
                    .and_where(Expr::col(collector::Column::Owner).eq(owner))
                    .and_where(Expr::col(collector::Column::LeaseUntil).gt(now)),
            )
            .await?
            .rows_affected()
            == 1)
    }
    pub async fn turn_collector_gap(&self, owner: &str) -> Result<()> {
        let now = now_ms();
        self.db
            .execute(
                Query::update()
                    .table(collector::Entity)
                    .value(
                        collector::Column::GapSince,
                        Func::coalesce([Expr::col(collector::Column::GapSince), Expr::val(now)]),
                    )
                    .value(collector::Column::LeaseUntil, now)
                    .and_where(Expr::col(collector::Column::Singleton))
                    .and_where(Expr::col(collector::Column::Owner).eq(owner)),
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paid_deadline_and_manual_override_have_independent_authority() {
        let mut p = BillingProfile {
            team_id: "1".into(),
            customer_id: None,
            subscription_id: Some("sub".into()),
            plan: Some("go".into()),
            subscription_status: Some("past_due".into()),
            paid_through: Some(100),
            period_anchor: 0,
            cancel_at_period_end: false,
            enterprise: false,
            grant_plan: None,
            grant_expires_at: None,
        };
        assert_eq!(p.effective_plan(true, 99), Plan::Go);
        assert_eq!(p.effective_plan(true, 100), Plan::Free);
        p.grant_plan = Some("enterprise".into());
        assert_eq!(p.effective_plan(true, 100), Plan::Enterprise);
        p.grant_plan = Some("pro".into());
        p.grant_expires_at = Some(99);
        assert_eq!(p.effective_plan(true, 98), Plan::Pro);
        assert_eq!(p.effective_plan(true, 99), Plan::Go);
        assert_eq!(p.effective_plan(true, 100), Plan::Free);
        p.grant_plan = Some("free".into());
        p.grant_expires_at = None;
        assert_eq!(p.effective_plan(true, 98), Plan::Free);
        assert_eq!(p.effective_plan(false, 100), Plan::SelfHosted);
        assert_eq!(Plan::Go.limits().turn_bytes, Some(2_147_483_648));
    }
}
