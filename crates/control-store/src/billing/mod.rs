//! Team-owned subscriptions, manual overrides, and authoritative usage admission.
mod admin;
mod admissions;
mod payments;
mod period;

pub use admin::AdminBillingPage;
pub use payments::{CheckoutAttempt, PaymentEvent, SubscriptionProjection};
pub use period::period_at;

use crate::{ControlStore, Error, Result, now_ms, one, resource_id, sql, timestamp};
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

fn metering_fresh(last_seen: Option<i64>, now: i64) -> bool {
    last_seen.is_some_and(|seen| now - seen < 60_000)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_active_sessions: Option<i64>,
    pub max_turns_per_session: Option<i64>,
    pub max_members: Option<i64>,
    pub turn_bytes: Option<i64>,
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
}

impl BillingProfile {
    pub fn effective_plan(&self, hosted: bool, now: i64) -> Plan {
        if !hosted {
            return Plan::SelfHosted;
        }
        if self.enterprise {
            return Plan::Enterprise;
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
        "plan":plan,"limits":plan.limits(),"enterpriseOverride":p.enterprise,
        "usage":{"activeSessionCount":usage.try_get::<i64>("","sessions")?,"memberCount":usage.try_get::<i64>("","members")?,"relayedBytes":usage.try_get::<String>("","bytes")?},
        "period":{"start":timestamp(start),"end":timestamp(end)},"nextResetAt":timestamp(end),
        "metering":{"lastSeenAt":last_seen.map(timestamp),"gapSince":meter.try_get::<Option<i64>>("","gap_since")?.map(timestamp),"fresh":metering_fresh(last_seen,now)},
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
        .query_one_raw(sql(
            "SELECT * FROM cp_billing_profiles WHERE team_id=$1",
            vec![team.into()],
        ))
        .await?;
    row.map(profile)
        .transpose()
        .map(|value| value.map_or(Plan::Free, |p| p.effective_plan(true, at)))
}

impl ControlStore {
    pub async fn billing_profile(&self, team_id: &str) -> Result<BillingProfile> {
        let team = resource_id(team_id)?;
        self.db.execute_raw(sql("INSERT INTO cp_billing_profiles(team_id,period_anchor) SELECT id,$2 FROM cp_teams WHERE id=$1 ON CONFLICT(team_id) DO NOTHING", vec![team.into(), now_ms().into()])).await?;
        profile(
            one(
                &self.db,
                "SELECT * FROM cp_billing_profiles WHERE team_id=$1",
                vec![team.into()],
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
        let row = one(&self.db,
            "SELECT (SELECT COUNT(*) FROM cp_session_admissions a JOIN cp_machines m ON m.id=a.machine_id WHERE a.team_id=$1 AND a.status<>'released' AND NOT m.revoked) AS sessions, (SELECT COUNT(*) FROM cp_members WHERE team_id=$1) AS members, cp_turn_sent_bytes($1,$2,$3)::text AS bytes",
            vec![resource_id(team_id)?.into(), start.into(), end.into()]).await?;
        let meter = one(
            &self.db,
            "SELECT last_seen_at,gap_since FROM cp_turn_collector WHERE singleton",
            vec![],
        )
        .await?;
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
        let meter = one(&self.db,"SELECT last_seen_at,cp_turn_sent_bytes($1,$2,$3)<$4::bigint AS allowed FROM cp_turn_collector WHERE singleton",vec![resource_id(team_id)?.into(),start.into(),end.into(),limit.into()]).await?;
        if !metering_fresh(meter.try_get("", "last_seen_at")?, now) {
            return Ok(Some(RelayDeniedReason::MeteringUnavailable));
        }
        let allowed: bool = meter.try_get("", "allowed")?;
        Ok((!allowed).then_some(RelayDeniedReason::TurnQuotaExhausted))
    }

    pub async fn save_peer_relay_decision(&self, peer_id: &str, allowed: bool) -> Result<()> {
        self.db
            .execute_raw(sql(
                "UPDATE cp_peers SET relay_allowed=$2 WHERE id=$1",
                vec![peer_id.into(), allowed.into()],
            ))
            .await?;
        Ok(())
    }
    pub async fn peer_relay_decision(&self, peer_id: &str) -> Result<bool> {
        Ok(one(
            &self.db,
            "SELECT relay_allowed FROM cp_peers WHERE id=$1",
            vec![peer_id.into()],
        )
        .await?
        .try_get("", "relay_allowed")?)
    }

    pub async fn set_enterprise(&self, actor: &str, team_id: &str, enabled: bool) -> Result<()> {
        if !self.hosted {
            return Err(Error::Invalid(
                "self-hosted installations already have unlimited allowances",
            ));
        }
        let tx = self.db.begin().await?;
        if tx
            .query_one_raw(sql(
                "SELECT user_id FROM cp_site_admins WHERE user_id=$1 FOR SHARE",
                vec![actor.into()],
            ))
            .await?
            .is_none()
        {
            return Err(Error::Forbidden);
        }
        let team = resource_id(team_id)?;
        one(
            &tx,
            "SELECT id FROM cp_teams WHERE id=$1 FOR UPDATE",
            vec![team.into()],
        )
        .await?;
        tx.execute_raw(sql("INSERT INTO cp_billing_profiles(team_id,period_anchor) VALUES($1,$2) ON CONFLICT(team_id) DO NOTHING",vec![team.into(),now_ms().into()])).await?;
        let before: bool = one(
            &tx,
            "SELECT enterprise FROM cp_billing_profiles WHERE team_id=$1 FOR UPDATE",
            vec![team.into()],
        )
        .await?
        .try_get("", "enterprise")?;
        if before != enabled {
            tx.execute_raw(sql(
                "UPDATE cp_billing_profiles SET enterprise=$2 WHERE team_id=$1",
                vec![team.into(), enabled.into()],
            ))
            .await?;
            tx.execute_raw(sql("INSERT INTO cp_site_audit(actor_user_id,source,action,before_value,after_value,occurred_at) VALUES($1,'user','enterprise.update',$2,$3,$4)",vec![actor.into(),json!({"teamId":team_id,"enterprise":before}).into(),json!({"teamId":team_id,"enterprise":enabled}).into(),now_ms().into()])).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Claim ownership before connecting; a lease alone is not evidence of healthy collection.
    pub async fn claim_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self.db.execute_raw(sql("UPDATE cp_turn_collector SET gap_since=CASE WHEN owner IS NOT NULL AND (lease_until IS NULL OR lease_until<$2) THEN COALESCE(gap_since,last_seen_at,$2) ELSE gap_since END,owner=$1,lease_until=$2+45000 WHERE singleton AND (owner=$1 OR lease_until IS NULL OR lease_until<$2)",vec![owner.into(),now.into()])).await?.rows_affected()==1)
    }
    /// Renew freshness only after a successful ping on the subscribed Redis connection.
    pub async fn heartbeat_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self.db.execute_raw(sql("UPDATE cp_turn_collector SET lease_until=$2+45000,last_seen_at=$2 WHERE singleton AND owner=$1 AND lease_until>$2",vec![owner.into(),now.into()])).await?.rows_affected()==1)
    }
    pub async fn turn_collector_gap(&self, owner: &str) -> Result<()> {
        self.db.execute_raw(sql("UPDATE cp_turn_collector SET gap_since=COALESCE(gap_since,$2),lease_until=$2 WHERE singleton AND owner=$1",vec![owner.into(),now_ms().into()])).await?;
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
        };
        assert_eq!(p.effective_plan(true, 99), Plan::Go);
        assert_eq!(p.effective_plan(true, 100), Plan::Free);
        p.enterprise = true;
        assert_eq!(p.effective_plan(true, 100), Plan::Enterprise);
        p.enterprise = false;
        assert_eq!(p.effective_plan(false, 100), Plan::SelfHosted);
        assert_eq!(Plan::Go.limits().turn_bytes, Some(2_147_483_648));
    }
}
