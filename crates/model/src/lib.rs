//! Shared resources for DeskFleet, independent of HTTP, Node.js, and persistence.
//!
//! Filesystem paths are strings interpreted by the owning machine. Deserializing
//! a record preserves them without accessing the filesystem.

pub mod agent;
mod directories;
mod ids;
mod resources;

pub use directories::{DirectoryBinding, DirectoryBindings, DirectoryBindingsError};
pub use ids::{
    AgentCommandId, AgentElicitationId, AgentInputId, AgentPermissionId, AgentSequence,
    AgentSessionId, AgentTurnId, MachineId, TeamId, TerminalSessionId, WorkspaceId, WorktreeId,
};
pub use resources::{
    AgentSession, Machine, Team, TerminalScope, TerminalSession, Workspace, WorkspaceSession,
    Worktree,
};
