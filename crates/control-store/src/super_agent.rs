//! Team Super Agent configuration (hosted cloud vs registered BYOA machine agent)
//! and unified Team Super Agent session index.
use crate::entities::{
    cp_cloud_sessions as cloud_sessions, cp_machine_registrations as registrations,
    cp_super_agent_machine_sessions as machine_sessions, cp_team_super_agent as team_config,
};
use crate::policies::{MachineAction, TeamAction, authorize};
use crate::{ControlStore, Error, Result, now_ms, resource_id};
use sea_orm::sea_query::{Expr, ExprTrait, JoinType, OnConflict, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SuperAgentMode {
    #[default]
    Hosted,
    Byoa,
}

impl SuperAgentMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hosted => "hosted",
            Self::Byoa => "byoa",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "hosted" => Ok(Self::Hosted),
            "byoa" => Ok(Self::Byoa),
            _ => Err(Error::Invalid("invalid Super Agent mode")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperAgentByoaTarget {
    #[serde(skip_serializing)]
    pub registration_id: String,
    pub machine_id: String,
    pub machine_name: String,
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub yolo: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSuperAgentConfig {
    pub mode: SuperAgentMode,
    pub byoa: Option<SuperAgentByoaTarget>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuperAgentByoaUpdate {
    pub machine_id: String,
    pub provider_id: String,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub yolo: bool,
}

fn present_option<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamSuperAgentConfigUpdate {
    pub mode: SuperAgentMode,
    /// Omit to retain any saved BYOA registration; pass `null` to clear it when in hosted mode.
    #[serde(default, deserialize_with = "present_option")]
    pub byoa: Option<Option<SuperAgentByoaUpdate>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperAgentSessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub last_active_at: i64,
    pub engine: SuperAgentMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterSuperAgentMachineSession {
    pub machine_id: String,
    pub session_id: String,
    pub provider_id: String,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub last_active_at: Option<i64>,
}

fn required_field(value: &str, max: usize, message: &'static str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > max || trimmed.chars().any(char::is_control)
    {
        return Err(Error::Invalid(message));
    }
    Ok(trimmed.to_owned())
}

fn optional_field(
    value: Option<&str>,
    max: usize,
    message: &'static str,
) -> Result<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max || trimmed.chars().any(char::is_control) {
        return Err(Error::Invalid(message));
    }
    Ok(Some(trimmed.to_owned()))
}

fn clean_title(value: Option<&str>) -> Option<String> {
    let raw = value?.trim().lines().next()?.trim_end();
    let cleaned: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

async fn active_registration(
    db: &impl ConnectionTrait,
    team: i64,
    registration_id: i64,
) -> Result<Option<registrations::Model>> {
    Ok(registrations::Entity::find_by_id(registration_id)
        .filter(registrations::Column::TeamId.eq(team))
        .filter(registrations::Column::Revoked.eq(false))
        .one(db)
        .await?)
}

async fn resolve_registration_by_machine(
    db: &impl ConnectionTrait,
    team: i64,
    machine_id: &str,
) -> Result<registrations::Model> {
    let machine = resource_id(machine_id)?;
    registrations::Entity::find()
        .filter(registrations::Column::TeamId.eq(team))
        .filter(registrations::Column::MachineId.eq(machine))
        .filter(registrations::Column::Revoked.eq(false))
        .one(db)
        .await?
        .ok_or(Error::NotFound)
}

async fn read_config(db: &impl ConnectionTrait, team: i64) -> Result<TeamSuperAgentConfig> {
    let Some(row) = team_config::Entity::find_by_id(team).one(db).await? else {
        return Ok(TeamSuperAgentConfig {
            mode: SuperAgentMode::Hosted,
            byoa: None,
        });
    };
    let mode = SuperAgentMode::parse(&row.mode)?;
    let byoa = match (row.registration_id, row.provider_id) {
        (Some(registration_id), Some(provider_id)) => {
            active_registration(db, team, registration_id)
                .await?
                .map(|registration| SuperAgentByoaTarget {
                    registration_id: registration.id.to_string(),
                    machine_id: registration.machine_id.to_string(),
                    machine_name: registration.name,
                    provider_id,
                    provider_name: row.provider_name,
                    cwd: row.cwd,
                    yolo: row.yolo,
                })
        }
        _ => None,
    };
    Ok(TeamSuperAgentConfig { mode, byoa })
}

impl ControlStore {
    pub async fn team_super_agent_config(&self, team_id: &str) -> Result<TeamSuperAgentConfig> {
        read_config(&self.db, resource_id(team_id)?).await
    }

    /// Update the Team's Super Agent mode and optional registered BYOA machine agent.
    ///
    /// # Errors
    /// Returns an error if the caller lacks admin authority, the target machine is not an
    /// active registration in this Team, or required BYOA fields are missing or invalid.
    pub async fn update_team_super_agent_config(
        &self,
        user_id: &str,
        team_id: &str,
        input: &TeamSuperAgentConfigUpdate,
    ) -> Result<TeamSuperAgentConfig> {
        let team = resource_id(team_id)?;
        let tx = self.db.begin().await?;
        authorize(
            &crate::teams::lock_team_policy(&tx, user_id, team_id).await?,
            TeamAction::ManageSuperAgent,
        )?;
        let existing = team_config::Entity::find_by_id(team).one(&tx).await?;
        let (registration_id, provider_id, provider_name, cwd, yolo) = match &input.byoa {
            Some(Some(byoa)) => {
                let registration =
                    resolve_registration_by_machine(&tx, team, &byoa.machine_id).await?;
                let provider_id =
                    required_field(&byoa.provider_id, 256, "invalid Super Agent provider ID")?;
                let provider_name = optional_field(
                    byoa.provider_name.as_deref(),
                    256,
                    "invalid Super Agent provider name",
                )?;
                let cwd = optional_field(
                    byoa.cwd.as_deref(),
                    4096,
                    "invalid Super Agent working directory",
                )?;
                (
                    Some(registration.id),
                    Some(provider_id),
                    provider_name,
                    cwd,
                    byoa.yolo,
                )
            }
            Some(None) => (None, None, None, None, false),
            None => match existing {
                Some(row) => (
                    row.registration_id,
                    row.provider_id,
                    row.provider_name,
                    row.cwd,
                    row.yolo,
                ),
                None => (None, None, None, None, false),
            },
        };

        if input.mode == SuperAgentMode::Byoa {
            let Some(reg_id) = registration_id else {
                return Err(Error::Invalid(
                    "select a machine and agent before switching to BYOA Super Agent",
                ));
            };
            if provider_id.is_none() || active_registration(&tx, team, reg_id).await?.is_none() {
                return Err(Error::Invalid(
                    "select an active machine and agent before switching to BYOA Super Agent",
                ));
            }
        }

        let updated_at = now_ms();
        team_config::Entity::insert(team_config::ActiveModel {
            team_id: Set(team),
            mode: Set(input.mode.as_str().to_owned()),
            registration_id: Set(registration_id),
            provider_id: Set(provider_id),
            provider_name: Set(provider_name),
            cwd: Set(cwd),
            yolo: Set(yolo),
            updated_at: Set(updated_at),
        })
        .on_conflict(
            OnConflict::column(team_config::Column::TeamId)
                .update_columns([
                    team_config::Column::Mode,
                    team_config::Column::RegistrationId,
                    team_config::Column::ProviderId,
                    team_config::Column::ProviderName,
                    team_config::Column::Cwd,
                    team_config::Column::Yolo,
                    team_config::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec_without_returning(&tx)
        .await?;

        let result = read_config(&tx, team).await?;
        tx.commit().await?;
        Ok(result)
    }

    /// Unified Team Super Agent conversation history across hosted cloud and BYOA machine agents.
    pub async fn super_agent_sessions(
        &self,
        team_id: &str,
    ) -> Result<Vec<SuperAgentSessionSummary>> {
        let team = resource_id(team_id)?;
        let hosted = cloud_sessions::Entity::find()
            .select_only()
            .columns([
                cloud_sessions::Column::SessionId,
                cloud_sessions::Column::Title,
                cloud_sessions::Column::LastActiveAt,
            ])
            .filter(cloud_sessions::Column::TeamId.eq(team))
            .order_by_desc(cloud_sessions::Column::LastActiveAt)
            .order_by_asc(cloud_sessions::Column::SessionId)
            .into_model::<crate::CloudSessionSummary>()
            .all(&self.db)
            .await?;

        let rows = self
            .db
            .query_all(
                Query::select()
                    .column((
                        machine_sessions::Entity,
                        machine_sessions::Column::SessionId,
                    ))
                    .column((machine_sessions::Entity, machine_sessions::Column::Title))
                    .column((
                        machine_sessions::Entity,
                        machine_sessions::Column::LastActiveAt,
                    ))
                    .column((
                        machine_sessions::Entity,
                        machine_sessions::Column::ProviderId,
                    ))
                    .column((
                        machine_sessions::Entity,
                        machine_sessions::Column::ProviderName,
                    ))
                    .column((registrations::Entity, registrations::Column::MachineId))
                    .expr_as(
                        Expr::col((registrations::Entity, registrations::Column::Name)),
                        sea_orm::sea_query::Alias::new("machine_name"),
                    )
                    .from(machine_sessions::Entity)
                    .join(
                        JoinType::InnerJoin,
                        registrations::Entity,
                        Expr::col((
                            machine_sessions::Entity,
                            machine_sessions::Column::RegistrationId,
                        ))
                        .equals((registrations::Entity, registrations::Column::Id)),
                    )
                    .and_where(
                        Expr::col((machine_sessions::Entity, machine_sessions::Column::TeamId))
                            .eq(team),
                    )
                    .and_where(
                        Expr::col((registrations::Entity, registrations::Column::Revoked))
                            .eq(false),
                    ),
            )
            .await?;

        let mut sessions = Vec::with_capacity(hosted.len() + rows.len());
        for item in hosted {
            sessions.push(SuperAgentSessionSummary {
                session_id: item.session_id,
                title: item.title,
                last_active_at: item.last_active_at,
                engine: SuperAgentMode::Hosted,
                machine_id: None,
                machine_name: None,
                provider_id: None,
                provider_name: None,
            });
        }
        for row in rows {
            sessions.push(SuperAgentSessionSummary {
                session_id: row.try_get("", "session_id")?,
                title: row.try_get("", "title")?,
                last_active_at: row.try_get("", "last_active_at")?,
                engine: SuperAgentMode::Byoa,
                machine_id: Some(row.try_get::<i64>("", "machine_id")?.to_string()),
                machine_name: Some(row.try_get("", "machine_name")?),
                provider_id: Some(row.try_get("", "provider_id")?),
                provider_name: row.try_get("", "provider_name")?,
            });
        }
        sessions.sort_by(|left, right| {
            right
                .last_active_at
                .cmp(&left.last_active_at)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        Ok(sessions)
    }

    /// Record or update a BYOA Super Agent machine session for unified Team history and
    /// cross-machine Super Agent MCP consent.
    pub async fn register_super_agent_machine_session(
        &self,
        user_id: &str,
        team_id: &str,
        input: &RegisterSuperAgentMachineSession,
    ) -> Result<SuperAgentSessionSummary> {
        let registration = self
            .authorize_registration(user_id, team_id, &input.machine_id, MachineAction::Manage)
            .await?;
        let team = resource_id(team_id)?;
        let reg_id = resource_id(&registration.id)?;
        let session_id = required_field(&input.session_id, 256, "invalid Super Agent session ID")?;
        let provider_id =
            required_field(&input.provider_id, 256, "invalid Super Agent provider ID")?;
        let provider_name = optional_field(
            input.provider_name.as_deref(),
            256,
            "invalid Super Agent provider name",
        )?;
        let title = clean_title(input.title.as_deref());
        let last_active_at = input
            .last_active_at
            .filter(|value| *value > 0)
            .unwrap_or_else(now_ms);

        let tx = self.db.begin().await?;
        let existing = machine_sessions::Entity::find_by_id((reg_id, session_id.clone()))
            .one(&tx)
            .await?;
        let (final_title, final_active, final_provider_name) = match existing {
            Some(row) => {
                if row.team_id != team {
                    return Err(Error::Conflict(
                        "Super Agent session already belongs to another Team",
                    ));
                }
                let merged_title = title.or(row.title);
                let merged_active = match row.last_active_at.cmp(&last_active_at) {
                    Ordering::Greater => row.last_active_at,
                    Ordering::Less | Ordering::Equal => last_active_at,
                };
                let merged_provider_name = provider_name.or(row.provider_name);
                machine_sessions::Entity::update_many()
                    .col_expr(
                        machine_sessions::Column::Title,
                        Expr::val(merged_title.clone()),
                    )
                    .col_expr(
                        machine_sessions::Column::LastActiveAt,
                        Expr::val(merged_active),
                    )
                    .col_expr(
                        machine_sessions::Column::ProviderName,
                        Expr::val(merged_provider_name.clone()),
                    )
                    .filter(machine_sessions::Column::RegistrationId.eq(reg_id))
                    .filter(machine_sessions::Column::SessionId.eq(&session_id))
                    .exec(&tx)
                    .await?;
                (merged_title, merged_active, merged_provider_name)
            }
            None => {
                machine_sessions::Entity::insert(machine_sessions::ActiveModel {
                    team_id: Set(team),
                    registration_id: Set(reg_id),
                    session_id: Set(session_id.clone()),
                    provider_id: Set(provider_id.clone()),
                    provider_name: Set(provider_name.clone()),
                    title: Set(title.clone()),
                    last_active_at: Set(last_active_at),
                })
                .exec_without_returning(&tx)
                .await?;
                (title, last_active_at, provider_name)
            }
        };
        tx.commit().await?;
        Ok(SuperAgentSessionSummary {
            session_id,
            title: final_title,
            last_active_at: final_active,
            engine: SuperAgentMode::Byoa,
            machine_id: Some(registration.machine_id),
            machine_name: Some(registration.name),
            provider_id: Some(provider_id),
            provider_name: final_provider_name,
        })
    }

    pub async fn is_super_agent_machine_session(
        &self,
        registration_id: &str,
        session_id: &str,
    ) -> Result<bool> {
        let reg_id = resource_id(registration_id)?;
        Ok(
            machine_sessions::Entity::find_by_id((reg_id, session_id.to_owned()))
                .one(&self.db)
                .await?
                .is_some(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_super_agent_fields_and_cleans_titles() {
        assert_eq!(
            required_field(" codex ", 256, "bad").unwrap(),
            "codex".to_owned()
        );
        assert!(required_field("   ", 256, "bad").is_err());
        assert!(required_field("bad\nvalue", 256, "bad").is_err());
        assert_eq!(optional_field(Some("  "), 256, "bad").unwrap(), None);
        assert_eq!(
            optional_field(Some("/tmp/work"), 4096, "bad").unwrap(),
            Some("/tmp/work".to_owned())
        );
        assert_eq!(
            clean_title(Some("  First line\nSecond line")),
            Some("First line".to_owned())
        );
        assert_eq!(clean_title(Some("   \n")), None);
    }

    #[test]
    fn parses_config_update_distinguishing_omitted_and_null_byoa() {
        let keep: TeamSuperAgentConfigUpdate =
            serde_json::from_str(r#"{"mode":"hosted"}"#).unwrap();
        assert_eq!(keep.mode, SuperAgentMode::Hosted);
        assert!(keep.byoa.is_none());

        let clear: TeamSuperAgentConfigUpdate =
            serde_json::from_str(r#"{"mode":"hosted","byoa":null}"#).unwrap();
        assert_eq!(clear.mode, SuperAgentMode::Hosted);
        assert!(matches!(clear.byoa, Some(None)));

        let set: TeamSuperAgentConfigUpdate = serde_json::from_str(
            r#"{"mode":"byoa","byoa":{"machineId":"12","providerId":"claude-code","yolo":true}}"#,
        )
        .unwrap();
        assert_eq!(set.mode, SuperAgentMode::Byoa);
        let byoa = set.byoa.unwrap().unwrap();
        assert_eq!(byoa.machine_id, "12");
        assert_eq!(byoa.provider_id, "claude-code");
        assert!(byoa.yolo);
    }
}
