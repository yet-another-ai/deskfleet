//! Action policies evaluate authority loaded by the owning operation.
//!
//! Policies do not authenticate callers or load records. Team and Machine
//! policies receive membership in the target Team, never a site-wide role.
//! Collection scopes apply that same boundary in SQL before returning records.
mod scopes;

pub use scopes::{MachineScope, TeamScope};

use crate::{Error, Result};

/// A resource policy has its own action type, so unrelated actions cannot mix.
pub trait Policy {
    type Action;

    fn permits(&self, action: Self::Action) -> bool;
}

/// Require permission for an explicit action before executing an operation.
///
/// # Errors
/// Returns [`Error::Forbidden`] when the policy denies the action.
pub fn authorize<P: Policy>(policy: &P, action: P::Action) -> Result<()> {
    if policy.permits(action) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SiteAction {
    ReadSettings,
    UpdateSettings,
    ReadAudit,
}

/// Authority over the deployment, independent of membership in any Team.
#[derive(Clone, Copy, Debug)]
pub struct SitePolicy {
    is_site_admin: bool,
}

impl SitePolicy {
    pub fn new(is_site_admin: bool) -> Self {
        Self { is_site_admin }
    }
}

impl Policy for SitePolicy {
    type Action = SiteAction;

    fn permits(&self, action: SiteAction) -> bool {
        match action {
            SiteAction::ReadSettings | SiteAction::UpdateSettings | SiteAction::ReadAudit => {
                self.is_site_admin
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamCreationAction {
    Create,
}

/// Site policy for new Teams; a site administrator observes the same setting.
#[derive(Clone, Copy, Debug)]
pub struct TeamCreationPolicy {
    allow_team_creation: bool,
}

impl TeamCreationPolicy {
    pub fn new(allow_team_creation: bool) -> Self {
        Self {
            allow_team_creation,
        }
    }
}

impl Policy for TeamCreationPolicy {
    type Action = TeamCreationAction;

    fn permits(&self, action: TeamCreationAction) -> bool {
        match action {
            TeamCreationAction::Create => self.allow_team_creation,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamRole {
    Admin,
    Member,
}

impl TeamRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }
}

impl std::str::FromStr for TeamRole {
    type Err = Error;

    fn from_str(role: &str) -> Result<Self> {
        match role {
            "admin" => Ok(Self::Admin),
            "member" => Ok(Self::Member),
            _ => Err(Error::Invalid("invalid team role")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamAction {
    Read,
    ReadMembers,
    ReadUsage,
    ReadMachines,
    EnrollMachine,
    Rename,
    Delete,
    ManageMembers,
}

/// Membership must be loaded for the operation's target Team.
#[derive(Clone, Copy, Debug)]
pub struct TeamPolicy {
    role: Option<TeamRole>,
}

impl TeamPolicy {
    pub fn new(role: Option<TeamRole>) -> Self {
        Self { role }
    }

    pub fn role(&self) -> Option<TeamRole> {
        self.role
    }
}

impl Policy for TeamPolicy {
    type Action = TeamAction;

    fn permits(&self, action: TeamAction) -> bool {
        match action {
            TeamAction::Read
            | TeamAction::ReadMembers
            | TeamAction::ReadUsage
            | TeamAction::ReadMachines
            | TeamAction::EnrollMachine => self.role.is_some(),
            TeamAction::Rename | TeamAction::Delete | TeamAction::ManageMembers => {
                self.role == Some(TeamRole::Admin)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MachineAction {
    Read,
    Rename,
    Manage,
    Connect,
    Remove,
}

/// Membership belongs to the target Machine's owning Team.
#[derive(Clone, Copy, Debug)]
pub struct MachinePolicy {
    team_role: Option<TeamRole>,
}

impl MachinePolicy {
    pub fn new(team_role: Option<TeamRole>) -> Self {
        Self { team_role }
    }
}

impl Policy for MachinePolicy {
    type Action = MachineAction;

    fn permits(&self, action: MachineAction) -> bool {
        match action {
            MachineAction::Read
            | MachineAction::Rename
            | MachineAction::Manage
            | MachineAction::Connect => self.team_role.is_some(),
            MachineAction::Remove => self.team_role == Some(TeamRole::Admin),
        }
    }
}
