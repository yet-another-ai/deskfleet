use serde::{Deserialize, Serialize};

use crate::{
    AgentSessionId, DirectoryBindings, MachineId, TeamId, TerminalSessionId, WorkspaceId,
    WorktreeId,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Team {
    pub id: TeamId,
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Machine {
    pub id: MachineId,
    pub team_id: TeamId,
    pub name: String,
}

/// A machine-owned workspace with one main worktree containing its configured directories.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub machine_id: MachineId,
    pub name: String,
}

/// A workspace's main directories, or a session's managed working directories.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Worktree {
    pub id: WorktreeId,
    /// Absent for machine-scoped Sessions that have no Workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    /// Absent only for the workspace's automatic main worktree.
    pub session_id: Option<AgentSessionId>,
    pub directories: DirectoryBindings,
}

/// The minimal persisted lifecycle record for a Session.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSession {
    pub id: AgentSessionId,
    pub machine_id: MachineId,
    /// Absent for machine-scoped Sessions started without a Workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
}

/// An agent session's workspace ownership and startup directory context.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AgentSession {
    pub id: AgentSessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    /// Optional managed worktree owned by this session.
    pub worktree_id: Option<WorktreeId>,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub cwd: String,
    pub directories: DirectoryBindings,
}

/// Exactly one owning scope; the scope does not confine the terminal's filesystem.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "id",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TerminalScope {
    Machine(MachineId),
    Workspace(WorkspaceId),
    Worktree(WorktreeId),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalSession {
    pub id: TerminalSessionId,
    pub scope: TerminalScope,
    /// Current or initial machine-local working directory, independent of scope.
    pub cwd: String,
    /// Optional context; it does not replace the terminal's owning scope.
    pub agent_session_id: Option<AgentSessionId>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terminal_scope_wire_format_preserves_all_three_ownership_levels() {
        let id = 1_i64;
        for (scope, kind) in [
            (TerminalScope::Machine(id.into()), "machine"),
            (TerminalScope::Workspace(id.into()), "workspace"),
            (TerminalScope::Worktree(id.into()), "worktree"),
        ] {
            let wire = json!({"kind": kind, "id": id.to_string()});
            assert_eq!(serde_json::to_value(scope).unwrap(), wire);
            assert_eq!(
                serde_json::from_value::<TerminalScope>(wire).unwrap(),
                scope
            );
        }
    }

    #[test]
    fn terminal_scope_rejects_ambiguous_or_unknown_ownership() {
        for invalid in [
            json!({"kind": "project", "id": "1"}),
            json!({
                "kind": "machine",
                "id": "1",
                "workspace_id": "1"
            }),
        ] {
            assert!(serde_json::from_value::<TerminalScope>(invalid).is_err());
        }
    }
}
