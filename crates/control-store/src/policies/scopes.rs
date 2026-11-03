use crate::MachineRegistration;
use crate::entities::{
    cp_machine_registrations as registrations, cp_members as members, cp_teams as teams,
};
use crate::{ControlStore, Result, machines::machine, resource_id};
use deskfleet_protocol::control::Team;
use sea_orm::sea_query::{Asterisk, Expr, ExprTrait, JoinType, Order, Query};
use sea_orm::{ColumnTrait, ConnectionTrait};

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
            .query_all(
                Query::select()
                    .columns([
                        (teams::Entity, teams::Column::Id),
                        (teams::Entity, teams::Column::Name),
                    ])
                    .column((members::Entity, members::Column::Role))
                    .from(teams::Entity)
                    .join(
                        JoinType::InnerJoin,
                        members::Entity,
                        Expr::col((members::Entity, members::Column::TeamId))
                            .eq(Expr::col((teams::Entity, teams::Column::Id))),
                    )
                    .and_where(members::Column::UserId.eq(self.user_id))
                    .order_by((teams::Entity, teams::Column::Id), Order::Asc),
            )
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
    pub async fn resolve(&self, store: &ControlStore) -> Result<Vec<MachineRegistration>> {
        store
            .authorize_team(self.user_id, self.team_id, TeamAction::ReadMachines)
            .await?;
        store
            .db
            .query_all(
                Query::select()
                    .column((registrations::Entity, Asterisk))
                    .from(registrations::Entity)
                    .join(
                        JoinType::InnerJoin,
                        members::Entity,
                        Expr::col((members::Entity, members::Column::TeamId)).eq(Expr::col((
                            registrations::Entity,
                            registrations::Column::TeamId,
                        ))),
                    )
                    .and_where(registrations::Column::TeamId.eq(resource_id(self.team_id)?))
                    .and_where(members::Column::UserId.eq(self.user_id))
                    .and_where(registrations::Column::Revoked.eq(false))
                    .order_by(
                        (registrations::Entity, registrations::Column::Id),
                        Order::Asc,
                    ),
            )
            .await?
            .into_iter()
            .map(machine)
            .collect()
    }
}
