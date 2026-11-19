//! Wayland clipboard integration over `org.freedesktop.portal.Clipboard`.
//!
//! When the portal grants clipboard access on the active `RemoteDesktop`
//! session, selection transfers and owner-change notifications run on the
//! Wayland D-Bus connection.

use std::{
    collections::HashMap,
    io::{Read, Write},
    os::fd::OwnedFd,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use futures_util::StreamExt;
use tokio::{sync::mpsc, task::JoinHandle};
use zbus::{Connection, OwnedObjectPath, OwnedVariant, Proxy, Variant};

use crate::Result;

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const CLIPBOARD: &str = "org.freedesktop.portal.Clipboard";
const MAX_CLIPBOARD_BYTES: usize = 32 * 1024;
const TEXT_MIME_TYPES: &[&str] = &[
    "text/plain;charset=utf-8",
    "UTF8_STRING",
    "text/plain",
    "STRING",
];

type Properties = HashMap<String, OwnedVariant>;

#[derive(Default)]
struct SharedClipboard {
    sender: Option<mpsc::UnboundedSender<String>>,
    incoming: Option<String>,
}

static SHARED: OnceLock<Arc<Mutex<SharedClipboard>>> = OnceLock::new();

fn shared() -> &'static Arc<Mutex<SharedClipboard>> {
    SHARED.get_or_init(|| Arc::new(Mutex::new(SharedClipboard::default())))
}

pub struct SessionClipboard {
    task: Option<JoinHandle<()>>,
}

impl Drop for SessionClipboard {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        if let Some(state) = SHARED.get() {
            let mut guard = state.lock().unwrap_or_else(|error| error.into_inner());
            guard.sender = None;
            guard.incoming = None;
        }
    }
}

pub async fn request_clipboard(connection: &Connection, session: &OwnedObjectPath) {
    let Ok(proxy) = Proxy::new_owned(connection.clone(), DESTINATION, PATH, CLIPBOARD).await else {
        return;
    };
    let options = HashMap::<&str, Variant<'_>>::new();
    let _ = tokio::time::timeout(
        Duration::from_millis(500),
        proxy.call::<_, _, ()>("RequestClipboard", &(session, options)),
    )
    .await;
}

pub async fn bind_session(
    connection: &Connection,
    session: &OwnedObjectPath,
    enabled: bool,
) -> SessionClipboard {
    if !enabled {
        return SessionClipboard { task: None };
    }
    let Ok(proxy) = Proxy::new_owned(connection.clone(), DESTINATION, PATH, CLIPBOARD).await else {
        return SessionClipboard { task: None };
    };
    let Ok(transfer_stream) = proxy.receive_signal("SelectionTransfer").await else {
        return SessionClipboard { task: None };
    };
    let Ok(owner_stream) = proxy.receive_signal("SelectionOwnerChanged").await else {
        return SessionClipboard { task: None };
    };

    let (sender, receiver) = mpsc::unbounded_channel();
    let state = Arc::clone(shared());
    {
        let mut guard = state.lock().unwrap_or_else(|error| error.into_inner());
        guard.sender = Some(sender);
        guard.incoming = None;
    }

    let session_path = session.clone();
    let task = tokio::spawn(run_portal_clipboard(
        proxy,
        session_path,
        transfer_stream,
        owner_stream,
        receiver,
        state,
    ));
    SessionClipboard { task: Some(task) }
}

pub fn set_clipboard(text: &str) -> Result<()> {
    let sender = {
        let guard = shared().lock().unwrap_or_else(|error| error.into_inner());
        guard.sender.clone()
    };
    if let Some(sender) = sender {
        let _ = sender.send(text.to_owned());
    }
    Ok(())
}

pub fn poll_clipboard() -> Result<Option<String>> {
    let mut guard = shared().lock().unwrap_or_else(|error| error.into_inner());
    Ok(guard.incoming.take())
}

async fn run_portal_clipboard(
    proxy: Proxy<'static>,
    session: OwnedObjectPath,
    mut transfer_stream: zbus::proxy::SignalStream<'static>,
    mut owner_stream: zbus::proxy::SignalStream<'static>,
    mut outgoing: mpsc::UnboundedReceiver<String>,
    state: Arc<Mutex<SharedClipboard>>,
) {
    let mut owned_text: Option<String> = None;
    loop {
        tokio::select! {
            command = outgoing.recv() => {
                let Some(text) = command else {
                    break;
                };
                owned_text = Some(text);
                let options = HashMap::from([(
                    "mime_types",
                    Variant::from(vec![
                        "text/plain;charset=utf-8",
                        "UTF8_STRING",
                        "text/plain",
                    ]),
                )]);
                let _ = proxy
                    .call::<_, _, ()>("SetSelection", &(&session, options))
                    .await;
            }
            Some(signal) = transfer_stream.next() => {
                let Ok((signal_session, _mime_type, serial)) =
                    signal.body().deserialize::<(OwnedObjectPath, String, u32)>()
                else {
                    continue;
                };
                if signal_session != session {
                    continue;
                }
                let Some(text) = owned_text.clone() else {
                    let _ = proxy
                        .call::<_, _, ()>("SelectionWriteDone", &(&session, serial, false))
                        .await;
                    continue;
                };
                let Ok(fd) = proxy
                    .call::<_, _, zbus::OwnedFd>("SelectionWrite", &(&session, serial))
                    .await
                else {
                    continue;
                };
                let std_fd: OwnedFd = fd.into();
                let wrote = tokio::task::spawn_blocking(move || write_fd_text(std_fd, &text))
                    .await
                    .unwrap_or(false);
                let _ = proxy
                    .call::<_, _, ()>("SelectionWriteDone", &(&session, serial, wrote))
                    .await;
            }
            Some(signal) = owner_stream.next() => {
                let Ok((signal_session, mut options)) =
                    signal.body().deserialize::<(OwnedObjectPath, Properties)>()
                else {
                    continue;
                };
                if signal_session != session {
                    continue;
                }
                let is_self = options
                    .remove("session_is_owner")
                    .and_then(|value| bool::try_from(value).ok())
                    .unwrap_or(false);
                if is_self {
                    continue;
                }
                let Some(mime_type) = options
                    .remove("mime_types")
                    .and_then(select_preferred_mime_type)
                else {
                    continue;
                };
                let Ok(fd) = proxy
                    .call::<_, _, zbus::OwnedFd>("SelectionRead", &(&session, mime_type.as_str()))
                    .await
                else {
                    continue;
                };
                let std_fd: OwnedFd = fd.into();
                if let Ok(Some(text)) =
                    tokio::task::spawn_blocking(move || read_fd_text(std_fd)).await
                {
                    let mut guard = state.lock().unwrap_or_else(|error| error.into_inner());
                    guard.incoming = Some(text);
                }
            }
            else => break,
        }
    }
}

fn select_preferred_mime_type(variant: OwnedVariant) -> Option<String> {
    let advertised = Vec::<String>::try_from(variant.clone())
        .or_else(|_| <(Vec<String>,)>::try_from(variant).map(|tuple| tuple.0))
        .ok()?;
    choose_text_mime(&advertised)
}

fn choose_text_mime(advertised: &[String]) -> Option<String> {
    for &preferred in TEXT_MIME_TYPES {
        if advertised.iter().any(|candidate| candidate == preferred) {
            return Some(preferred.to_owned());
        }
    }
    None
}

fn write_fd_text(fd: OwnedFd, text: &str) -> bool {
    let mut file = std::fs::File::from(fd);
    file.write_all(text.as_bytes()).is_ok() && file.flush().is_ok()
}

fn read_fd_text(fd: OwnedFd) -> Option<String> {
    let file = std::fs::File::from(fd);
    let mut buffer = Vec::new();
    file.take((MAX_CLIPBOARD_BYTES + 1) as u64)
        .read_to_end(&mut buffer)
        .ok()?;
    if buffer.is_empty() || buffer.len() > MAX_CLIPBOARD_BYTES {
        return None;
    }
    let text = String::from_utf8(buffer).ok()?.replace('\0', "");
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_utf8_text_mime_in_priority_order() {
        let mimes = vec!["TEXT".to_owned(), "UTF8_STRING".to_owned()];
        assert_eq!(choose_text_mime(&mimes).as_deref(), Some("UTF8_STRING"));
        let mimes = vec![
            "text/plain".to_owned(),
            "text/plain;charset=utf-8".to_owned(),
        ];
        assert_eq!(
            choose_text_mime(&mimes).as_deref(),
            Some("text/plain;charset=utf-8")
        );
        assert_eq!(choose_text_mime(&["image/png".to_owned()]), None);
    }
}
