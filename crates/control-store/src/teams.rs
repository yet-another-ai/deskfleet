use crate::policies::{
    TeamAction, TeamCreationAction, TeamCreationPolicy, TeamPolicy, TeamScope, authorize,
};
use crate::{
    ControlStore, Error, Result, json_rows, name, now_ms, one, resource_id, secret, secret_hash,
    sql, timestamp,
};
use deskfleet_protocol::control::Team;
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Value, json};

impl ControlStore {
    pub(crate) async fn team_policy(&self, user_id: &str, team_id: &str) -> Result<TeamPolicy> {
        team_policy(&self.db, user_id, team_id).await
    }
    pub async fn team_role(&self, user_id: &str, team_id: &str) -> Result<String> {
        let policy = self.team_policy(user_id, team_id).await?;
        authorize(&policy, TeamAction::Read)?;
        Ok(policy.role().ok_or(Error::Forbidden)?.as_str().into())
    }
    /// Authorize a Team action against the caller's current membership.
    ///
    /// # Errors
    /// Returns an error for denied actions, invalid IDs, or database failures.
    pub async fn authorize_team(
        &self,
        user_id: &str,
        team_id: &str,
        action: TeamAction,
    ) -> Result<()> {
        authorize(&self.team_policy(user_id, team_id).await?, action)
    }
    pub async fn require_admin(&self, user_id: &str, team_id: &str) -> Result<()> {
        self.authorize_team(user_id, team_id, TeamAction::ManageMembers)
            .await
    }
    pub async fn teams(&self, user_id: &str) -> Result<Vec<Team>> {
        TeamScope::new(user_id).resolve(self).await
    }
    /// Return cumulative TURN outbound bytes and current Team resource counts.
    ///
    /// Sessions use their latest synchronized archive state, independent of
    /// execution or machine presence. Removed machines do not contribute.
    ///
    /// # Errors
    /// Returns an error for nonmembers, an invalid Team ID, or a database failure.
    pub async fn team_usage(&self, user_id: &str, team_id: &str) -> Result<Value> {
        self.authorize_team(user_id, team_id, TeamAction::ReadUsage)
            .await?;
        let row = one(
            &self.db,
            "SELECT jsonb_build_object(
                'relayedBytes', (SELECT COALESCE(SUM(sent_bytes),0)::text FROM cp_turn_usage WHERE team_id=$1),
                'activeSessionCount', (SELECT COUNT(*) FROM cp_sessions s JOIN cp_machines m ON m.id=s.machine_id WHERE m.team_id=$1 AND NOT m.revoked AND s.snapshot#>>'{session,archiveState}' IS DISTINCT FROM 'archived'),
                'memberCount', (SELECT COUNT(*) FROM cp_members WHERE team_id=$1)
            ) AS record",
            vec![resource_id(team_id)?.into()],
        )
        .await?;
        Ok(row.try_get("", "record")?)
    }
    pub async fn create_team(&self, user_id: &str, value: &str) -> Result<Team> {
        let value = name(value)?;
        let tx = self.db.begin().await?;
        let allow_creation = one(
            &tx,
            "SELECT allow_team_creation FROM cp_site_settings WHERE singleton FOR SHARE",
            vec![],
        )
        .await?
        .try_get("", "allow_team_creation")?;
        authorize(
            &TeamCreationPolicy::new(allow_creation),
            TeamCreationAction::Create,
        )?;
        let id = one(
            &tx,
            "INSERT INTO cp_teams(name) VALUES($1) RETURNING id",
            vec![value.into()],
        )
        .await?
        .try_get::<i64>("", "id")?;
        tx.execute_raw(sql(
            "INSERT INTO cp_members VALUES($1,$2,'admin')",
            vec![id.into(), user_id.into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(Team {
            id: id.to_string(),
            name: value.to_owned(),
            role: "admin".into(),
        })
    }
    pub async fn rename_team(&self, user_id: &str, team_id: &str, value: &str) -> Result<Team> {
        self.authorize_team(user_id, team_id, TeamAction::Rename)
            .await?;
        let value = name(value)?;
        self.db
            .execute_raw(sql(
                "UPDATE cp_teams SET name=$1 WHERE id=$2",
                vec![value.into(), resource_id(team_id)?.into()],
            ))
            .await?;
        Ok(Team {
            id: team_id.into(),
            name: value.into(),
            role: "admin".into(),
        })
    }
    pub async fn delete_team(&self, user_id: &str, team_id: &str) -> Result<()> {
        self.authorize_team(user_id, team_id, TeamAction::Delete)
            .await?;
        let tx = self.db.begin().await?;
        let id = resource_id(team_id)?;
        one(
            &tx,
            "SELECT id FROM cp_teams WHERE id=$1 FOR UPDATE",
            vec![id.into()],
        )
        .await?;
        authorize(
            &team_policy(&tx, user_id, team_id).await?,
            TeamAction::Delete,
        )?;
        if tx
            .query_one_raw(sql(
                "SELECT id FROM cp_machines WHERE team_id=$1 LIMIT 1",
                vec![id.into()],
            ))
            .await?
            .is_some()
        {
            return Err(Error::Conflict("team still owns machine records"));
        }
        tx.execute_raw(sql("DELETE FROM cp_teams WHERE id=$1", vec![id.into()]))
            .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn members(&self, user_id: &str, team_id: &str) -> Result<Vec<Value>> {
        self.authorize_team(user_id, team_id, TeamAction::ReadMembers)
            .await?;
        json_rows(&self.db,"SELECT jsonb_build_object('userId',u.id,'name',u.name,'email',u.email,'role',m.role) AS record FROM cp_members m JOIN cp_users u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY u.id",vec![resource_id(team_id)?.into()]).await
    }
    pub async fn change_member(
        &self,
        actor: &str,
        team_id: &str,
        user_id: &str,
        role: Option<&str>,
    ) -> Result<()> {
        if role.is_some_and(|r| r != "admin" && r != "member") {
            return Err(Error::Invalid("invalid team role"));
        }
        let tx = self.db.begin().await?;
        let id = resource_id(team_id)?;
        one(
            &tx,
            "SELECT id FROM cp_teams WHERE id=$1 FOR UPDATE",
            vec![id.into()],
        )
        .await?;
        authorize(
            &team_policy(&tx, actor, team_id).await?,
            TeamAction::ManageMembers,
        )?;
        let current = one(
            &tx,
            "SELECT role FROM cp_members WHERE team_id=$1 AND user_id=$2",
            vec![id.into(), user_id.into()],
        )
        .await?
        .try_get::<String>("", "role")?;
        if current == "admin" && role != Some("admin") {
            let count = one(
                &tx,
                "SELECT count(*) AS n FROM cp_members WHERE team_id=$1 AND role='admin'",
                vec![id.into()],
            )
            .await?
            .try_get::<i64>("", "n")?;
            if count <= 1 {
                return Err(Error::Conflict("team must retain an administrator"));
            }
        }
        if let Some(role) = role {
            tx.execute_raw(sql(
                "UPDATE cp_members SET role=$1 WHERE team_id=$2 AND user_id=$3",
                vec![role.into(), id.into(), user_id.into()],
            ))
            .await?;
        } else {
            tx.execute_raw(sql(
                "DELETE FROM cp_members WHERE team_id=$1 AND user_id=$2",
                vec![id.into(), user_id.into()],
            ))
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn invite(
        &self,
        user_id: &str,
        team_id: &str,
        email: &str,
        role: &str,
    ) -> Result<Value> {
        self.authorize_team(user_id, team_id, TeamAction::ManageMembers)
            .await?;
        if role != "admin" && role != "member" {
            return Err(Error::Invalid("invalid team role"));
        }
        let email = email.trim().to_lowercase();
        if !email.contains('@') || email.len() > 320 {
            return Err(Error::Invalid("invalid invitation email"));
        }
        let token = secret();
        let expires = now_ms() + 7 * 24 * 60 * 60 * 1000;
        self.db
            .execute_raw(sql(
                "INSERT INTO cp_invites VALUES($1,$2,$3,$4,$5)",
                vec![
                    secret_hash(&token).into(),
                    resource_id(team_id)?.into(),
                    email.into(),
                    role.into(),
                    expires.into(),
                ],
            ))
            .await?;
        Ok(json!({"token":token,"expiresAt":timestamp(expires)}))
    }
    pub async fn accept_invite(&self, user_id: &str, token: &str) -> Result<Team> {
        let tx = self.db.begin().await?;
        let invite=one(&tx,"SELECT i.team_id,i.email,i.role,t.name FROM cp_invites i JOIN cp_teams t ON t.id=i.team_id WHERE i.token_hash=$1 AND i.expires_at>$2 FOR UPDATE OF i",vec![secret_hash(token).into(),now_ms().into()]).await?;
        let user = one(
            &tx,
            "SELECT email,email_verified FROM cp_users WHERE id=$1",
            vec![user_id.into()],
        )
        .await?;
        if !user.try_get::<bool>("", "email_verified")?
            || user
                .try_get::<Option<String>>("", "email")?
                .map(|s| s.to_lowercase())
                != Some(invite.try_get("", "email")?)
        {
            return Err(Error::Forbidden);
        }
        let id = invite.try_get::<i64>("", "team_id")?;
        let role = invite.try_get::<String>("", "role")?;
        tx.execute_raw(sql(
            "INSERT INTO cp_members VALUES($1,$2,$3) ON CONFLICT(team_id,user_id) DO NOTHING",
            vec![id.into(), user_id.into(), role.clone().into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "DELETE FROM cp_invites WHERE token_hash=$1",
            vec![secret_hash(token).into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(Team {
            id: id.to_string(),
            name: invite.try_get("", "name")?,
            role: self.team_role(user_id, &id.to_string()).await?,
        })
    }
}

async fn team_policy(
    db: &impl ConnectionTrait,
    user_id: &str,
    team_id: &str,
) -> Result<TeamPolicy> {
    let role = db
        .query_one_raw(sql(
            "SELECT role FROM cp_members WHERE team_id=$1 AND user_id=$2",
            vec![resource_id(team_id)?.into(), user_id.into()],
        ))
        .await?
        .map(|row| row.try_get::<String>("", "role"))
        .transpose()?
        .map(|role| role.parse())
        .transpose()?;
    Ok(TeamPolicy::new(role))
}
impl ControlStore {
    pub async fn team_user_ids(&self, team_id: &str) -> Result<Vec<String>> {
        self.db
            .query_all_raw(sql(
                "SELECT user_id FROM cp_members WHERE team_id=$1",
                vec![resource_id(team_id)?.into()],
            ))
            .await?
            .into_iter()
            .map(|r| r.try_get("", "user_id").map_err(Error::from))
            .collect()
    }
}
