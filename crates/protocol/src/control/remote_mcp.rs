//! Session-delegated cross-machine discovery and MCP execution.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RemoteMcpOperation {
    Machines,
    Machine,
    Sessions,
    Session,
    History,
    SessionCreate,
    SessionSend,
    WorkspaceCreate,
    McpServers,
    McpTools,
    McpCall,
    FilesRead,
    FilesWrite,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteMcpRequest {
    pub user_id: String,
    pub device_id: String,
    pub session_id: String,
    pub operation: RemoteMcpOperation,
    #[ts(optional)]
    pub machine_id: Option<String>,
    #[ts(type = "Record<string, unknown>")]
    pub arguments: Value,
}

#[cfg(test)]
mod tests {
    use super::RemoteMcpOperation;
    use serde_json::json;

    #[test]
    fn workspace_create_operation_round_trips_camel_case() {
        assert_eq!(
            serde_json::to_value(RemoteMcpOperation::WorkspaceCreate).unwrap(),
            json!("workspaceCreate")
        );
        assert_eq!(
            serde_json::from_value::<RemoteMcpOperation>(json!("workspaceCreate")).unwrap(),
            RemoteMcpOperation::WorkspaceCreate
        );
    }
}
