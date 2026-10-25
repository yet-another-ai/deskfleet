//! Authenticated machine and viewer sockets, with bounded outbound queues.
use crate::{
    AppState,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, web};
use actix_ws::{CloseCode, CloseReason};
use deskfleet_protocol::control::ControlMessage;
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;

pub async fn daemon(
    req: HttpRequest,
    payload: web::Payload,
    state: web::Data<AppState>,
) -> Result<HttpResponse> {
    connect(req, payload, state, true).await
}
pub async fn client(
    req: HttpRequest,
    payload: web::Payload,
    state: web::Data<AppState>,
) -> Result<HttpResponse> {
    connect(req, payload, state, false).await
}
async fn connect(
    req: HttpRequest,
    payload: web::Payload,
    state: web::Data<AppState>,
    is_daemon: bool,
) -> Result<HttpResponse> {
    let (response, mut session, stream) =
        actix_ws::handle(&req, payload).map_err(|_| ApiError::bad("invalid WebSocket upgrade"))?;
    actix_web::rt::spawn(async move {
        let mut stream = stream
            .max_frame_size(64 * 1024 * 1024)
            .aggregate_continuations()
            .max_continuation_size(64 * 1024 * 1024);
        let first = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
        let token = match first {
            Ok(Some(Ok(actix_ws::AggregatedMessage::Text(text)))) => {
                match serde_json::from_str::<ControlMessage>(&text) {
                    Ok(ControlMessage::Authenticate { token }) if token.len() < 512 => token,
                    _ => {
                        let _ = session.close(Some(close_reason(4401))).await;
                        return;
                    }
                }
            }
            _ => {
                let _ = session.close(Some(close_reason(4401))).await;
                return;
            }
        };
        let identity = if is_daemon {
            state
                .store
                .authenticate_machine(&token)
                .await
                .map(|m| (m.machine.id, Some(m.machine.team_id), None))
        } else {
            state
                .store
                .authenticate(&token)
                .await
                .map(|s| (s.id, None, Some(s.user.id)))
        };
        let (id, team, user) = match identity {
            Ok(identity) => identity,
            Err(error) => {
                let _ = session
                    .close(Some(close_reason(store_failure_close(&error, 4401))))
                    .await;
                return;
            }
        };
        let connection_id = uuid::Uuid::new_v4().to_string();
        let (send, mut receive) = tokio::sync::mpsc::channel(128);
        let (shutdown, mut shutdown_rx) = tokio::sync::watch::channel(None);
        if let Some(user) = &user {
            state
                .hub
                .add_client(&id, user, &connection_id, send, shutdown)
                .await;
        } else {
            state
                .hub
                .add_daemon(&id, &connection_id, send, shutdown)
                .await;
            let _ = state.store.machine_seen(&id).await;
        }
        let ready = ControlMessage::Ready {
            server_id: state.config.public_url.clone(),
            machine_id: is_daemon.then(|| id.clone()),
            team_id: team.clone(),
        };
        let setup = async {
            send_json(&mut session, &ready).await?;
            if is_daemon {
                let peers = state.store.valid_machine_peers(&id).await.map_err(|_| ())?;
                send_json(&mut session, &ControlMessage::ReconcilePeers { peers }).await?;
                if let Some(team) = &team {
                    state
                        .notify_team(
                            team,
                            ControlMessage::Presence {
                                machine_id: id.clone(),
                                online: true,
                            },
                        )
                        .await;
                }
            }
            Ok::<_, ()>(())
        }
        .await;
        let mut close_code = 1000;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
        let mut last_pong = std::time::Instant::now();
        while setup.is_ok() {
            tokio::select! {
                _=shutdown_rx.changed()=>{close_code=(*shutdown_rx.borrow()).unwrap_or(1012);break;},
                outgoing=receive.recv()=>match outgoing{
                    Some(message)=>{if send_json(&mut session,&message).await.is_err(){break}},
                    None=>break,
                },
                incoming=stream.next()=>match incoming{
                    Some(Ok(actix_ws::AggregatedMessage::Text(text)))=>{
                        let Ok(message)=serde_json::from_str::<ControlMessage>(&text)else{break};
                        match message{
                            ControlMessage::Ping=>{last_pong=std::time::Instant::now();let _=send_json(&mut session,&ControlMessage::Pong).await;},
                            ControlMessage::Pong=>last_pong=std::time::Instant::now(),
                            ControlMessage::Response{id:request_id,result,error} if is_daemon=>{
                                let result=match error{
                                    Some(e)=>{
                                        let mut failure=ApiError::new(actix_web::http::StatusCode::BAD_GATEWAY,"daemon_error",e.message);
                                        if e.reason.as_deref()==Some("encoder"){failure.reason=Some("encoder".to_owned());}
                                        Err(failure)
                                    }
                                    None=>Ok(result.unwrap_or(Value::Null)),
                                };
                                state.hub.response(&id,&connection_id,&request_id,result).await;
                            },
                            ControlMessage::PeerEvent{peer_id,event} if is_daemon=>{
                                if state.hub.is_current(&id,&connection_id).await {
                                    let state=state.clone(); let machine_id=id.clone(); let connection_id=connection_id.clone();
                                    actix_web::rt::spawn(async move { let _=crate::peers::daemon_event(&state,&machine_id,&connection_id,peer_id,event).await; });
                                }
                            },
                            _=>break,
                        }
                    },
                    Some(Ok(actix_ws::AggregatedMessage::Ping(bytes)))=>{last_pong=std::time::Instant::now();let _=session.pong(&bytes).await;},
                    Some(Ok(actix_ws::AggregatedMessage::Pong(_)))=>last_pong=std::time::Instant::now(),
                    _=>break,
                },
                _=heartbeat.tick()=>{
                    if last_pong.elapsed()>Duration::from_secs(60){break}
                    let active=if is_daemon{state.store.machine(&id).await.map(|_|true)}else{state.store.session_is_active(&id).await};
                    match active {
                        Ok(true)=>{},
                        Ok(false)=>{close_code=4401;break;},
                        Err(error)=>{close_code=store_failure_close(&error,if is_daemon{4403}else{4401});break;},
                    }
                    if is_daemon{let _=state.store.machine_seen(&id).await;}
                    if session.ping(b"deskfleet").await.is_err(){break}
                }
            }
        }
        if is_daemon {
            if state.hub.remove_daemon(&id, &connection_id).await
                && let Some(team) = team
            {
                state
                    .notify_team(
                        &team,
                        ControlMessage::Presence {
                            machine_id: id,
                            online: false,
                        },
                    )
                    .await;
            }
        } else {
            state.hub.remove_client(&id, &connection_id).await;
        }
        let _ = session.close(Some(close_reason(close_code))).await;
    });
    Ok(response)
}
async fn send_json(
    session: &mut actix_ws::Session,
    message: &ControlMessage,
) -> std::result::Result<(), ()> {
    let json = serde_json::to_string(message).map_err(|_| ())?;
    tokio::time::timeout(Duration::from_secs(10), session.text(json))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

fn close_reason(code: u16) -> CloseReason {
    CloseReason {
        code: CloseCode::from(code),
        description: None,
    }
}

fn store_failure_close(error: &deskfleet_control_store::Error, revoked_code: u16) -> u16 {
    use deskfleet_control_store::Error;
    match error {
        Error::Unauthorized | Error::Forbidden | Error::NotFound => revoked_code,
        _ => 1012,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn transient_storage_failure_does_not_revoke_existing_peer_access() {
        use deskfleet_control_store::Error;
        assert_eq!(super::store_failure_close(&Error::NotFound, 4403), 4403);
        assert_eq!(super::store_failure_close(&Error::Unauthorized, 4401), 4401);
        assert_eq!(
            super::store_failure_close(&Error::Invalid("temporary fixture failure"), 4403),
            1012
        );
    }
}
