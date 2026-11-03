//! A Team's own TURN REST API server, which replaces the site relay for the
//! Team's new peer grants when its plan and the site setting allow it.
use crate::entities::{cp_team_turn_servers as servers, cp_turn_settings as turn};
use crate::{
    ControlStore, Error, Result,
    billing::effective_plan,
    now_ms,
    policies::{TeamAction, authorize},
    resource_id,
    teams::lock_team_policy,
    turn_settings::turn_urls,
};
use deskfleet_protocol::control::{TeamTurnAvailability, TeamTurnSettings, TeamTurnSettingsUpdate};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set, TransactionTrait};
use serde_json::json;

/// Signing material for a Team relay. It is deliberately not `Debug` or
/// serializable so the secret cannot reach logs or API responses.
pub struct TeamTurnServer {
    pub urls: Vec<String>,
    pub secret: String,
}

const MAX_SECRET_BYTES: usize = 1024;

fn shared_secret(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > MAX_SECRET_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(Error::Invalid(
            "TURN shared secrets must be 1 to 1024 bytes without control characters or surrounding spaces",
        ));
    }
    Ok(value)
}

/// The site switch takes precedence: upgrading cannot enable a disabled feature.
async fn availability(
    db: &impl ConnectionTrait,
    team: i64,
    hosted: bool,
) -> Result<TeamTurnAvailability> {
    let allowed = turn::Entity::find_by_id(true)
        .one(db)
        .await?
        .is_none_or(|row| row.allow_team_servers);
    if !allowed {
        return Ok(TeamTurnAvailability::DisabledBySite);
    }
    if !effective_plan(db, team, hosted, now_ms())
        .await?
        .limits()
        .team_turn_servers
    {
        return Ok(TeamTurnAvailability::PlanRequired);
    }
    Ok(TeamTurnAvailability::Available)
}
async fn stored_urls(db: &impl ConnectionTrait, team: i64) -> Result<Option<Vec<String>>> {
    servers::Entity::find_by_id(team)
        .one(db)
        .await?
        .map(|row| serde_json::from_value(row.urls).map_err(Error::from))
        .transpose()
}
fn settings(availability: TeamTurnAvailability, urls: Option<Vec<String>>) -> TeamTurnSettings {
    TeamTurnSettings {
        availability,
        secret_configured: urls.is_some(),
        urls: urls.unwrap_or_default(),
    }
}
impl ControlStore {
    /// Team owners and administrators read the URLs and whether a secret is stored.
    pub async fn team_turn_settings(
        &self,
        user_id: &str,
        team_id: &str,
    ) -> Result<TeamTurnSettings> {
        self.authorize_team(user_id, team_id, TeamAction::ManageTurnServers)
            .await?;
        let team = resource_id(team_id)?;
        Ok(settings(
            availability(&self.db, team, self.hosted).await?,
            stored_urls(&self.db, team).await?,
        ))
    }
    /// Replace or remove the Team server. Removal is always permitted so a Team
    /// can delete its secret after a downgrade or a site-wide disable.
    pub async fn update_team_turn_settings(
        &self,
        user_id: &str,
        team_id: &str,
        input: &TeamTurnSettingsUpdate,
    ) -> Result<TeamTurnSettings> {
        let urls = turn_urls(&input.urls)?;
        let secret = input.secret.as_deref().map(shared_secret).transpose()?;
        let team = resource_id(team_id)?;
        let tx = self.db.begin().await?;
        authorize(
            &lock_team_policy(&tx, user_id, team_id).await?,
            TeamAction::ManageTurnServers,
        )?;
        let availability = availability(&tx, team, self.hosted).await?;
        if urls.is_empty() {
            if secret.is_some() {
                return Err(Error::Invalid(
                    "Add a TURN URL before saving a shared secret",
                ));
            }
            servers::Entity::delete_by_id(team).exec(&tx).await?;
        } else {
            match availability {
                TeamTurnAvailability::Available => {}
                TeamTurnAvailability::PlanRequired => {
                    return Err(Error::Conflict(
                        "Your own TURN server requires a Pro or Enterprise plan",
                    ));
                }
                TeamTurnAvailability::DisabledBySite => {
                    return Err(Error::Conflict(
                        "Site administrators have disabled Team TURN servers",
                    ));
                }
            }
            let urls = json!(urls);
            let changed = if let Some(secret) = secret {
                servers::Entity::insert(servers::ActiveModel {
                    team_id: Set(team),
                    urls: Set(urls),
                    secret: Set(secret.into()),
                })
                .on_conflict(
                    OnConflict::column(servers::Column::TeamId)
                        .update_columns([servers::Column::Urls, servers::Column::Secret])
                        .to_owned(),
                )
                .exec_without_returning(&tx)
                .await?
            } else {
                servers::Entity::update_many()
                    .col_expr(servers::Column::Urls, Expr::val(urls))
                    .filter(servers::Column::TeamId.eq(team))
                    .exec(&tx)
                    .await?
                    .rows_affected
            };
            if changed == 0 {
                return Err(Error::Invalid("Enter the TURN shared secret"));
            }
        }
        let result = settings(availability, stored_urls(&tx, team).await?);
        tx.commit().await?;
        Ok(result)
    }
    /// The server used for a new grant, or `None` to apply site relay rules.
    /// A configured server that is no longer available stays stored but unused.
    pub async fn team_turn_server(&self, team_id: &str) -> Result<Option<TeamTurnServer>> {
        let team = resource_id(team_id)?;
        let Some(row) = servers::Entity::find_by_id(team).one(&self.db).await? else {
            return Ok(None);
        };
        if availability(&self.db, team, self.hosted).await? != TeamTurnAvailability::Available {
            return Ok(None);
        }
        Ok(Some(TeamTurnServer {
            urls: serde_json::from_value(row.urls)?,
            secret: row.secret,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::shared_secret;

    #[test]
    fn shared_secrets_are_bounded_printable_and_unpadded() {
        for valid in ["s", "north-relay secret", &"x".repeat(1024)] {
            assert_eq!(shared_secret(valid).unwrap(), valid);
        }
        for invalid in [
            "",
            " padded",
            "padded ",
            "line\nbreak",
            "tab\tbed",
            &"x".repeat(1025),
        ] {
            assert!(shared_secret(invalid).is_err(), "accepted {invalid:?}");
        }
    }
}
