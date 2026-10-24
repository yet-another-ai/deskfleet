use crate::{
    ControlStore, Error, Result, json_rows, name, now_ms, one, resource_id, secret, secret_hash,
    sql, timestamp,
};
use deskfleet_protocol::control::Team;
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Value, json};

impl ControlStore {
    pub async fn team_role(&self, user_id: &str, team_id: &str) -> Result<String> {
        self.db
            .query_one_raw(sql(
                "SELECT role FROM cp_members WHERE team_id=$1 AND user_id=$2",
                vec![resource_id(team_id)?.into(), user_id.into()],
            ))
            .await?
            .ok_or(Error::Forbidden)?
            .try_get("", "role")
            .map_err(Error::from)
    }
    pub async fn require_admin(&self, user_id: &str, team_id: &str) -> Result<()> {
        if self.team_role(user_id, team_id).await? != "admin" {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
    pub async fn teams(&self, user_id: &str) -> Result<Vec<Team>> {
        self.db.query_all_raw(sql("SELECT t.id,t.name,m.role FROM cp_teams t JOIN cp_members m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.id",vec![user_id.into()])).await?.into_iter().map(|r|Ok(Team{id:r.try_get::<i64>("","id")?.to_string(),name:r.try_get("","name")?,role:r.try_get("","role")?})).collect()
    }
    pub async fn create_team(&self, user_id: &str, value: &str) -> Result<Team> {
        let value = name(value)?;
        let tx = self.db.begin().await?;
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
        self.require_admin(user_id, team_id).await?;
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
        self.require_admin(user_id, team_id).await?;
        let tx = self.db.begin().await?;
        let id = resource_id(team_id)?;
        one(
            &tx,
            "SELECT id FROM cp_teams WHERE id=$1 FOR UPDATE",
            vec![id.into()],
        )
        .await?;
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
        self.team_role(user_id, team_id).await?;
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
        let actor_role = one(
            &tx,
            "SELECT role FROM cp_members WHERE team_id=$1 AND user_id=$2",
            vec![id.into(), actor.into()],
        )
        .await?
        .try_get::<String>("", "role")?;
        if actor_role != "admin" {
            return Err(Error::Forbidden);
        }
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
        self.require_admin(user_id, team_id).await?;
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
