//! The deployment's persisted plan catalog and its audited administrative updates.
use super::Plan;
use crate::entities::{
    cp_plan_limits as catalog, cp_site_admins as admins, cp_site_audit as audit,
};
use crate::policies::{SiteAction, SitePolicy, authorize};
use crate::{ControlStore, Error, Result, now_ms};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DbErr, EntityTrait, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// A null numeric limit means unlimited. Every field is required when replacing a plan.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    #[serde(deserialize_with = "Option::deserialize")]
    pub max_active_sessions: Option<i64>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub max_turns_per_session: Option<i64>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub max_members: Option<i64>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub turn_bytes: Option<i64>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub super_agent_tokens: Option<i64>,
    /// A Team can use its own TURN server when the site permits it.
    pub team_turn_servers: bool,
}

impl Limits {
    fn validate(&self) -> Result<()> {
        // Limits travel through both the Rust API and JavaScript clients as JSON numbers.
        const JS_SAFE_INTEGER: i64 = (1_i64 << 53) - 1;
        let values = [
            self.max_active_sessions,
            self.max_turns_per_session,
            self.max_members,
            self.turn_bytes,
            self.super_agent_tokens,
        ];
        if values
            .into_iter()
            .flatten()
            .all(|v| (0..=JS_SAFE_INTEGER).contains(&v))
        {
            Ok(())
        } else {
            Err(Error::Invalid(
                "plan limits must be nonnegative safe integers or null",
            ))
        }
    }
}

impl From<&catalog::Model> for Limits {
    fn from(row: &catalog::Model) -> Self {
        Self {
            max_active_sessions: row.max_active_sessions,
            max_turns_per_session: row.max_turns_per_session,
            max_members: row.max_members,
            turn_bytes: row.turn_bytes,
            super_agent_tokens: row.super_agent_tokens,
            team_turn_servers: row.team_turn_servers,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct PlanLimits {
    pub plan: Plan,
    #[serde(flatten)]
    pub limits: Limits,
}

fn missing(plan: Plan) -> Error {
    DbErr::RecordNotFound(format!("missing billing limits for {}", plan.as_str())).into()
}

pub(crate) async fn plan_limits(db: &impl ConnectionTrait, plan: Plan) -> Result<Limits> {
    let row = catalog::Entity::find_by_id(plan.as_str())
        .one(db)
        .await?
        .ok_or_else(|| missing(plan))?;
    Ok(Limits::from(&row))
}

impl ControlStore {
    pub async fn plan_limits(&self, plan: Plan) -> Result<Limits> {
        plan_limits(&self.db, plan).await
    }

    /// Fetch every offer in display order with a single database snapshot.
    pub async fn list_plan_limits(&self) -> Result<Vec<PlanLimits>> {
        let rows = catalog::Entity::find().all(&self.db).await?;
        [
            Plan::Free,
            Plan::Go,
            Plan::Pro,
            Plan::Enterprise,
            Plan::SelfHosted,
        ]
        .into_iter()
        .map(|plan| {
            let row = rows
                .iter()
                .find(|row| row.plan == plan.as_str())
                .ok_or_else(|| missing(plan))?;
            Ok(PlanLimits {
                plan,
                limits: Limits::from(row),
            })
        })
        .collect()
    }

    pub async fn admin_plan_limits(&self, actor_id: &str) -> Result<Vec<PlanLimits>> {
        authorize(
            &SitePolicy::new(self.is_site_admin(actor_id).await?),
            SiteAction::ReadSettings,
        )?;
        self.list_plan_limits().await
    }

    /// A replacement and its audit receipt commit together while the actor's grant is held.
    pub async fn update_plan_limits(
        &self,
        actor_id: &str,
        plan: Plan,
        limits: Limits,
    ) -> Result<PlanLimits> {
        let tx = self.db.begin().await?;
        let is_admin = admins::Entity::find_by_id(actor_id)
            .lock_shared()
            .one(&tx)
            .await?
            .is_some();
        authorize(&SitePolicy::new(is_admin), SiteAction::UpdateSettings)?;
        if plan == Plan::SelfHosted {
            return Err(Error::Invalid("self-hosted entitlements are fixed"));
        }
        limits.validate()?;
        let current = catalog::Entity::find_by_id(plan.as_str())
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or_else(|| missing(plan))?;
        let before = PlanLimits {
            plan,
            limits: Limits::from(&current),
        };
        let after = PlanLimits { plan, limits };
        if before != after {
            catalog::ActiveModel {
                plan: sea_orm::Unchanged(current.plan),
                max_active_sessions: Set(limits.max_active_sessions),
                max_turns_per_session: Set(limits.max_turns_per_session),
                max_members: Set(limits.max_members),
                turn_bytes: Set(limits.turn_bytes),
                super_agent_tokens: Set(limits.super_agent_tokens),
                team_turn_servers: Set(limits.team_turn_servers),
            }
            .update(&tx)
            .await?;
            audit::Entity::insert(audit::ActiveModel {
                actor_user_id: Set(Some(actor_id.into())),
                source: Set("user".into()),
                action: Set("plan.limits.update".into()),
                before_value: Set(json!(before)),
                after_value: Set(json!(after)),
                occurred_at: Set(now_ms()),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
        }
        tx.commit().await?;
        Ok(after)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_a_plan_requires_explicit_caps_and_preserves_null() {
        let mut all = json!({
            "maxActiveSessions": 3, "maxTurnsPerSession": 30, "maxMembers": 3,
            "turnBytes": 0, "superAgentTokens": null, "teamTurnServers": false
        });
        assert_eq!(
            serde_json::from_value::<Limits>(all.clone())
                .unwrap()
                .super_agent_tokens,
            None
        );
        all.as_object_mut().unwrap().remove("superAgentTokens");
        assert!(serde_json::from_value::<Limits>(all).is_err());
    }
}
