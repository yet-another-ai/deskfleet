use crate::{ControlStore, Result, machines::machine, resource_id, sql};
use deskfleet_protocol::control::{Machine, Team};
use sea_orm::ConnectionTrait;

use super::TeamAction;

/// Teams visible through the user's actual memberships, including site admins.
#[derive(Clone, Copy, Debug)]
pub struct TeamScope<'a> {
    user_id: &'a str,
}

impl<'a> TeamScope<'a> {
    pub fn new(user_id: &'a str) -> Self {
        Self { user_id }
    }

    /// Resolve the membership scope in SQL before records leave storage.
    ///
    /// # Errors
    /// Returns an error when the database query or record decoding fails.
    pub async fn resolve(&self, store: &ControlStore) -> Result<Vec<Team>> {
        store
            .db
            .query_all_raw(sql(
                "SELECT t.id,t.name,m.role FROM cp_teams t JOIN cp_members m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.id",
                vec![self.user_id.into()],
            ))
            .await?
            .into_iter()
            .map(|row| {
                Ok(Team {
                    id: row.try_get::<i64>("", "id")?.to_string(),
                    name: row.try_get("", "name")?,
                    role: row.try_get("", "role")?,
                })
            })
            .collect()
    }
}

/// Active machines in one Team that the user belongs to.
#[derive(Clone, Copy, Debug)]
pub struct MachineScope<'a> {
    user_id: &'a str,
    team_id: &'a str,
}

impl<'a> MachineScope<'a> {
    pub fn new(user_id: &'a str, team_id: &'a str) -> Self {
        Self { user_id, team_id }
    }

    /// Authorize the Team and apply its membership boundary in the query.
    ///
    /// # Errors
    /// Returns an error for nonmembers, invalid IDs, or database failures.
    pub async fn resolve(&self, store: &ControlStore) -> Result<Vec<Machine>> {
        store
            .authorize_team(self.user_id, self.team_id, TeamAction::ReadMachines)
            .await?;
        store
            .db
            .query_all_raw(sql(
                "SELECT machine.* FROM cp_machines machine JOIN cp_members member ON member.team_id=machine.team_id WHERE machine.team_id=$1 AND member.user_id=$2 AND NOT machine.revoked ORDER BY machine.id",
                vec![resource_id(self.team_id)?.into(), self.user_id.into()],
            ))
            .await?
            .into_iter()
            .map(machine)
            .collect()
    }
}
