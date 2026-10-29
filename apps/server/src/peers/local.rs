//! Central grants for an authenticated local IPC claim, without ICE or relay allocation.

use super::{Create, PeerTransport, authorize, create_grant};
use crate::{
    AppState,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, web};
use serde_json::{Value, json};

pub async fn create(
    req: HttpRequest,
    s: web::Data<AppState>,
    b: web::Json<Create>,
) -> Result<web::Json<Value>> {
    if !matches!(b.purpose.as_str(), "agent" | "terminal") {
        return Err(ApiError::bad("unsupported local peer purpose"));
    }
    let (authorization, actor, expires) = create_grant(&req, &s, &b, PeerTransport::Local).await?;
    let id = &authorization.peer_id;
    s.store
        .save_peer(&authorization, &actor.id, expires)
        .await?;
    // The daemon receives this secret over its trusted control connection and
    // consumes it once when the local main process claims the IPC attachment.
    // It is deliberately absent from the grant, journals, and reconciliation.
    let payload = json!({
        "peerId": id,
        "authorization": authorization,
        "token": deskfleet_control_store::secret(),
    });
    let result = async {
        s.hub
            .request(
                &authorization.target_machine.id,
                "peer.local",
                payload.clone(),
                Some(authorization.actor.clone()),
            )
            .await?;
        // Logout, removal, and expiry can happen while another API instance
        // delivers the request to the daemon. Never return a newly revoked claim.
        authorize(&req, &s, id).await?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let peers = s.store.revoke_peer(id).await?;
        s.hub.revoke(peers, "local_connection_failed").await?;
        return Err(error);
    }
    Ok(web::Json(payload))
}
