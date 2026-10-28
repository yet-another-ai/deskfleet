//! JSON contracts shared by authenticated clients and the machine control link.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
}

/// Public runtime configuration for one deskfleet installation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiteSettings {
    pub site_name: String,
    pub announcement: String,
    pub allow_team_creation: bool,
    pub terms_of_service_url: String,
    pub privacy_terms_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub origin_id: String,
    pub local_machine_id: String,
    #[ts(type = "unknown")]
    pub capabilities: Value,
    pub online: bool,
    pub last_seen_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerActor {
    pub kind: String,
    pub user_id: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub source_machine: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerTarget {
    pub id: String,
    pub origin_id: String,
    pub local_machine_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerAuthorization {
    pub peer_id: String,
    pub server_id: String,
    pub team_id: String,
    pub actor: PeerActor,
    pub target_machine: PeerTarget,
    pub purpose: String,
    pub actions: Vec<String>,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
    // Present only for a desktop encoder failure that can try another codec.
    // Older daemons omit it; callers treat absence as a terminal failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// The first message on either WebSocket authenticates that connection. Tokens
/// never enter a URL, resource payload, or application journal.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlMessage {
    Authenticate {
        token: String,
    },
    Ready {
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "machineId", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
        #[serde(rename = "teamId", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        team_id: Option<String>,
    },
    Request {
        id: String,
        method: String,
        #[ts(type = "unknown")]
        params: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        actor: Option<PeerActor>,
    },
    Response {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "unknown")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<RpcError>,
    },
    PeerEvent {
        #[serde(rename = "peerId")]
        peer_id: String,
        #[ts(type = "unknown")]
        event: Value,
    },
    PeerRevoked {
        #[serde(rename = "peerId")]
        peer_id: String,
        reason: String,
    },
    ReconcilePeers {
        peers: Vec<PeerAuthorization>,
    },
    CatalogChanged {
        #[serde(rename = "machineId")]
        machine_id: String,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        session_id: Option<String>,
    },
    MachinesChanged {
        #[serde(rename = "teamId")]
        team_id: String,
    },
    Presence {
        #[serde(rename = "machineId")]
        machine_id: String,
        online: bool,
    },
    Ping,
    Pong,
}

/// Type-only bindings consumed by the browser and daemon. JSON resource payloads
/// deliberately remain opaque here; their feature owners validate those models.
pub fn typescript() -> String {
    let config = ts_rs::Config::default();
    let declarations = [
        User::decl(&config),
        SiteSettings::decl(&config),
        Team::decl(&config),
        Machine::decl(&config),
        PeerActor::decl(&config),
        PeerTarget::decl(&config),
        PeerAuthorization::decl(&config),
        IceServer::decl(&config),
        RpcError::decl(&config),
        ControlMessage::decl(&config),
    ];
    let mut output = String::from(
        "// Generated by cargo run -p deskfleet-protocol --example export_types. Do not edit.\n",
    );
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    #[test]
    fn generated_control_types_are_current() {
        assert_eq!(
            super::typescript(),
            include_str!("../control.ts"),
            "run cargo run -p deskfleet-protocol --example export_types"
        );
    }
}
