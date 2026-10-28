//! Durable agent records shared by the daemon and transactional store.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    AgentCommandId, AgentElicitationId, AgentInputId, AgentPermissionId, AgentSequence,
    AgentSessionId, AgentTurnId, MachineId, WorkspaceId,
};

macro_rules! states {
    ($(#[$enum_attr:meta])* $name:ident { $($(#[$variant_attr:meta])* $variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$enum_attr])*
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$variant_attr])* #[serde(rename = $wire)] $variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }
        }
    };
}

states!(ActorKind {
    LocalToken => "local_token",
    User => "user",
    System => "system",
});
states!(
    /// Sessions recorded before the execution context was selectable used a worktree.
    #[derive(Default)]
    SessionContext {
        #[default]
        Worktree => "worktree",
        Directory => "directory",
    }
);

states!(SessionLifecycle {
    Provisioning => "provisioning",
    Ready => "ready",
    ProvisionFailed => "provision_failed",
    Deleting => "deleting",
});
states!(
    #[derive(Default)]
    ArchiveState {
        #[default]
        Active => "active",
        Archiving => "archiving",
        Archived => "archived",
    }
);

states!(RunState {
    Starting => "starting",
    Running => "running",
    Stopping => "stopping",
    Stopped => "stopped",
    Interrupted => "interrupted",
    Failed => "failed",
});
states!(CommandStatus {
    Accepted => "accepted",
    Completed => "completed",
    Rejected => "rejected",
    Failed => "failed",
    Uncertain => "uncertain",
});
states!(InputState {
    Pending => "pending",
    Dispatching => "dispatching",
    Delivered => "delivered",
    Failed => "failed",
    Withdrawn => "withdrawn",
    Uncertain => "uncertain",
});
states!(RequestedDelivery {
    Backlog => "backlog",
    Steer => "steer",
});
states!(ActualDelivery {
    TurnStart => "turn_start",
    Steer => "steer",
});
states!(TurnState {
    Starting => "starting",
    Running => "running",
    Cancelling => "cancelling",
    Completed => "completed",
    Cancelled => "cancelled",
    Interrupted => "interrupted",
    Failed => "failed",
});
states!(PermissionState {
    Pending => "pending",
    Resolved => "resolved",
    Cancelled => "cancelled",
});
states!(ElicitationState {
    Pending => "pending",
    Resolved => "resolved",
    Cancelled => "cancelled",
});
states!(EventKind {
    Session => "session",
    Run => "run",
    Input => "input",
    Turn => "turn",
    Permission => "permission",
    Elicitation => "elicitation",
    Acp => "acp",
    Command => "command",
});

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineReference {
    pub origin_id: String,
    pub id: MachineId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActor {
    pub kind: ActorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_machine: Option<MachineReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AgentCapabilities {
    pub steering: bool,
    pub resume: bool,
    #[serde(default)]
    pub fork: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRecord {
    pub id: AgentSessionId,
    /// Absent for machine-scoped Sessions started without a Workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub title: String,
    /// A user rename takes precedence over later provider title updates.
    #[serde(default)]
    pub title_customized: bool,
    /// A generated worktree, or the Workspace's own directories used in place.
    #[serde(default)]
    pub context: SessionContext,
    pub lifecycle: SessionLifecycle,
    /// Independent of provisioning and provider process state.
    #[serde(default)]
    pub archive_state: ArchiveState,
    /// Consumption captured from the source when this Session was forked.
    #[serde(default)]
    pub inherited_turn_count: u32,
    /// Central admission generation; replaced only when restoring an archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission_generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_limit_reason: Option<String>,
    pub last_event_seq: AgentSequence,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<AgentCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub session_id: AgentSessionId,
    pub generation: u64,
    pub state: RunState,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub id: AgentCommandId,
    pub operation_id: String,
    pub actor: AgentActor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<AgentSessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    pub method: String,
    pub params: Map<String, Value>,
    pub is_canonical: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicting_command_id: Option<AgentCommandId>,
    pub status: CommandStatus,
    #[serde(
        default,
        deserialize_with = "present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub received_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInput {
    pub id: AgentInputId,
    pub session_id: AgentSessionId,
    pub submission_command_id: AgentCommandId,
    pub author: AgentActor,
    pub content: Vec<Value>,
    pub accepted_seq: AgentSequence,
    pub state: InputState,
    pub requested_delivery: RequestedDelivery,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_turn_id: Option<AgentTurnId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatch_command_id: Option<AgentCommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatcher: Option<AgentActor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_delivery: Option<ActualDelivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<AgentTurnId>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurn {
    pub id: AgentTurnId,
    pub session_id: AgentSessionId,
    pub initial_input_id: AgentInputId,
    pub dispatch_command_id: AgentCommandId,
    pub run_generation: u64,
    pub state: TurnState,
    /// Set durably before provider dispatch; never cleared after dispatch begins.
    #[serde(default)]
    pub consumed: bool,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// Original ACP prompt-response token usage for this turn, when reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermission {
    pub id: AgentPermissionId,
    pub session_id: AgentSessionId,
    pub run_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<AgentTurnId>,
    pub request: Value,
    pub state: PermissionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_command_id: Option<AgentCommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<AgentActor>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

/// A durable ACP question and the first response accepted for its running agent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentElicitation {
    pub id: AgentElicitationId,
    pub session_id: AgentSessionId,
    pub run_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<AgentTurnId>,
    pub request: Value,
    pub state: ElicitationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_command_id: Option<AgentCommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<AgentActor>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    /// The agent completed a URL flow; accepting its link alone does not complete it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventDraft {
    pub session_id: AgentSessionId,
    pub kind: EventKind,
    pub payload: Value,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<AgentTurnId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_id: Option<AgentInputId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<AgentCommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_generation: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentEvent {
    pub seq: AgentSequence,
    #[serde(flatten)]
    pub event: AgentEventDraft,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub session: AgentSessionRecord,
    pub runs: Vec<AgentRun>,
    pub inputs: Vec<AgentInput>,
    pub turns: Vec<AgentTurn>,
    pub permissions: Vec<AgentPermission>,
    #[serde(default)]
    pub elicitations: Vec<AgentElicitation>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCommit {
    pub session_id: Option<AgentSessionId>,
    pub expected_seq: Option<AgentSequence>,
    pub session: Option<AgentSessionRecord>,
    #[serde(default)]
    pub runs: Vec<AgentRun>,
    #[serde(default)]
    pub inputs: Vec<AgentInput>,
    #[serde(default)]
    pub turns: Vec<AgentTurn>,
    #[serde(default)]
    pub permissions: Vec<AgentPermission>,
    #[serde(default)]
    pub elicitations: Vec<AgentElicitation>,
    pub command: Option<AgentCommand>,
    #[serde(default)]
    pub events: Vec<AgentEventDraft>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommitResult {
    pub events: Vec<AgentEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<AgentSessionRecord>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCreateSession {
    pub command: AgentCommand,
    /// Omit to create a machine-scoped Session without a Workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    pub provider: String,
    pub title: String,
    pub context: SessionContext,
    #[serde(default)]
    pub inherited_turn_count: u32,
    #[serde(default)]
    pub admission_generation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentCreatedSession {
    pub command: AgentCommand,
    pub session: AgentSessionRecord,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentity {
    pub origin_id: String,
    pub machine_id: MachineId,
}

// JSON-RPC distinguishes a successful null result from an absent result.
fn present_json<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
