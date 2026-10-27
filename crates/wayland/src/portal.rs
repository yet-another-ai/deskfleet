//! The portal adapter retains ScreenCast v6 fields that older wrappers discard.
use std::{
    collections::HashMap,
    os::fd::OwnedFd,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use futures_util::StreamExt;
use zbus::{Connection, OwnedObjectPath, OwnedVariant, Proxy, Variant, proxy::SignalStream};

use crate::{
    APP_ID, Error, PermissionSnapshot, PermissionStatus, Result, Source, input::Eis, token,
};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREEN: &str = "org.freedesktop.portal.ScreenCast";
type Properties = HashMap<String, OwnedVariant>;

pub struct Live {
    pub connection: Connection,
    pub session: OwnedObjectPath,
    pub closed: SignalStream<'static>,
    pub owner_changed: SignalStream<'static>,
    pub sources: Vec<Source>,
    pub snapshot: PermissionSnapshot,
    pub input: Option<Eis>,
}

impl Live {
    pub async fn open_pipewire(&self, id: u32) -> Result<(OwnedFd, Source)> {
        let source = self
            .sources
            .iter()
            .find(|source| source.id == id)
            .ok_or(Error::StaleSource)?
            .clone();
        let proxy = desktop_proxy(&self.connection, SCREEN).await?;
        let fd: zbus::OwnedFd = proxy
            .call(
                "OpenPipeWireRemote",
                &(&self.session, HashMap::<&str, Variant<'_>>::new()),
            )
            .await?;
        Ok((fd.into(), source))
    }

    pub async fn close(mut self) {
        if let Some(input) = self.input.as_mut() {
            let _ = input.detach();
        }
        // Closing our private bus connection also cancels any pending portal request.
        if let Ok(proxy) = Proxy::new_owned(
            self.connection.clone(),
            DESTINATION,
            self.session.clone(),
            "org.freedesktop.portal.Session",
        )
        .await
        {
            let _ =
                tokio::time::timeout(Duration::from_secs(1), proxy.call::<_, _, ()>("Close", &()))
                    .await;
        }
        let _ = self.connection.close().await;
    }
}

async fn desktop_proxy(connection: &Connection, interface: &'static str) -> Result<Proxy<'static>> {
    Ok(Proxy::new_owned(connection.clone(), DESTINATION, PATH, interface).await?)
}

pub async fn supported() -> Result<bool> {
    if !is_wayland_session() {
        return Ok(false);
    }
    let check = async {
        let connection = Connection::session().await?;
        let result = capabilities(&connection).await;
        let _ = connection.close().await;
        result
    };
    match tokio::time::timeout(Duration::from_millis(800), check).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(_)) | Err(_) => Ok(false),
    }
}

async fn capabilities(connection: &Connection) -> Result<()> {
    let remote = desktop_proxy(connection, REMOTE).await?;
    let screen = desktop_proxy(connection, SCREEN).await?;
    let version: u32 = remote.get_property("version").await?;
    let devices: u32 = remote.get_property("AvailableDeviceTypes").await?;
    let sources: u32 = screen.get_property("AvailableSourceTypes").await?;
    let cursors: u32 = screen.get_property("AvailableCursorModes").await?;
    if version < 2 || devices & 3 != 3 || sources & 1 == 0 || cursors & 2 == 0 {
        return Err(Error::Unavailable(
            "RemoteDesktop v2 with keyboard/pointer and monitor capture with an embedded cursor is required".into(),
        ));
    }
    Ok(())
}

pub async fn authorize(
    directory: &Path,
    restore_only: bool,
    connection_slot: &mut Option<Connection>,
    next_id: &mut u32,
) -> Result<Live> {
    if !is_wayland_session() {
        return Err(Error::Unavailable(
            "a logged-in Wayland session is required".into(),
        ));
    }
    let restore = token::read(directory)?;
    if restore_only && restore.is_none() {
        return Err(Error::PermissionDenied);
    }
    crate::identity::ensure_desktop_entry()?;
    let connection = Connection::session().await?;
    *connection_slot = Some(connection.clone());
    // Registration must be the first portal call on this connection. The desktop
    // file installed by the app uses this same basename on every launch.
    desktop_proxy(&connection, "org.freedesktop.host.portal.Registry")
        .await?
        .call::<_, _, ()>("Register", &(APP_ID, HashMap::<&str, Variant<'_>>::new()))
        .await?;
    capabilities(&connection).await?;
    let bus = Proxy::new_owned(
        connection.clone(),
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    )
    .await?;
    let owner_changed = bus
        .receive_signal_with_args("NameOwnerChanged", &[(0, DESTINATION)])
        .await?;
    let session_token = unique_token();
    let mut created = request(
        &connection,
        REMOTE,
        "CreateSession",
        None,
        HashMap::from([(
            "session_handle_token",
            Variant::from(session_token.as_str()),
        )]),
    )
    .await?;
    let session: OwnedObjectPath = String::try_from(
        created
            .remove("session_handle")
            .ok_or_else(|| malformed("missing session handle"))?,
    )?
    .try_into()?;
    let session_proxy = Proxy::new_owned(
        connection.clone(),
        DESTINATION,
        session.clone(),
        "org.freedesktop.portal.Session",
    )
    .await?;
    let closed = session_proxy.receive_signal("Closed").await?;
    let mut options = HashMap::from([
        ("types", Variant::from(3u32)),
        ("persist_mode", Variant::from(2u32)),
    ]);
    if let Some(restore) = restore.as_deref() {
        options.insert("restore_token", Variant::from(restore));
    }
    request(
        &connection,
        REMOTE,
        "SelectDevices",
        Some(&session),
        options,
    )
    .await?;
    request(
        &connection,
        SCREEN,
        "SelectSources",
        Some(&session),
        HashMap::from([
            ("types", Variant::from(1u32)),
            ("multiple", Variant::from(true)),
            ("cursor_mode", Variant::from(2u32)),
        ]),
    )
    .await?;
    // Persistence belongs to RemoteDesktop.SelectDevices for a combined session.
    let mut selected =
        request(&connection, REMOTE, "Start", Some(&session), HashMap::new()).await?;
    let grants = selected
        .remove("devices")
        .map(u32::try_from)
        .transpose()?
        .unwrap_or_default();
    let returned_token = selected
        .remove("restore_token")
        .map(String::try_from)
        .transpose()?;
    token::write(directory, returned_token.as_deref())?;
    let raw_streams = selected
        .remove("streams")
        .map(Vec::<(u32, Properties)>::try_from)
        .transpose()?
        .unwrap_or_default();
    let sources = parse_sources(raw_streams, next_id)?;
    // Input setup must not discard streams the user already granted.
    let input = if grants & 3 == 3 && !sources.is_empty() {
        connect_input(&connection, &session).await
    } else {
        None
    };
    let control = input
        .as_ref()
        .is_some_and(|input| sources.iter().any(|source| input.controls(source)));
    let snapshot = granted_snapshot(!sources.is_empty(), control, returned_token.is_some());
    Ok(Live {
        connection,
        session,
        closed,
        owner_changed,
        sources,
        snapshot,
        input,
    })
}

pub(crate) async fn connect_input(
    connection: &Connection,
    session: &OwnedObjectPath,
) -> Option<Eis> {
    let connected = async {
        let remote = desktop_proxy(connection, REMOTE).await?;
        let fd: zbus::OwnedFd = remote
            .call(
                "ConnectToEIS",
                &(session, HashMap::<&str, Variant<'_>>::new()),
            )
            .await?;
        Eis::connect(fd.into()).await
    }
    .await;
    match connected {
        Ok(input) => Some(input),
        Err(error) => {
            tracing::warn!(%error, "Wayland screen capture remains available without remote input");
            None
        }
    }
}

fn granted_snapshot(screen_capture: bool, control: bool, persistent: bool) -> PermissionSnapshot {
    PermissionSnapshot {
        screen_capture,
        control: screen_capture && control,
        status: PermissionStatus::Granted,
        persistent,
    }
}

fn parse_sources(raw_streams: Vec<(u32, Properties)>, next_id: &mut u32) -> Result<Vec<Source>> {
    let mut sources = Vec::with_capacity(raw_streams.len());
    for (index, (node_id, mut properties)) in raw_streams.into_iter().enumerate() {
        let (width, height) = properties
            .remove("size")
            .map(<(i32, i32)>::try_from)
            .transpose()?
            .unwrap_or_default();
        let id = allocate_id(next_id)?;
        sources.push(Source {
            id,
            name: format!("Display {}", index + 1),
            width: u32::try_from(width).unwrap_or_default(),
            height: u32::try_from(height).unwrap_or_default(),
            node_id,
            pipewire_serial: properties
                .remove("pipewire-serial")
                .map(u64::try_from)
                .transpose()?,
            mapping_id: properties
                .remove("mapping_id")
                .map(String::try_from)
                .transpose()?,
        });
    }
    Ok(sources)
}

fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty())
        || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
}

// Subscribe before making the call: a restored session can answer immediately.
async fn request(
    connection: &Connection,
    interface: &'static str,
    method: &str,
    session: Option<&OwnedObjectPath>,
    mut options: HashMap<&str, Variant<'_>>,
) -> Result<Properties> {
    let token = unique_token();
    options.insert("handle_token", Variant::from(token.clone()));
    let sender = connection
        .unique_name()
        .ok_or(Error::Stopped)?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("{PATH}/request/{sender}/{token}");
    let request_proxy = Proxy::new_owned(
        connection.clone(),
        DESTINATION,
        path.clone(),
        "org.freedesktop.portal.Request",
    )
    .await?;
    let mut response = request_proxy.receive_signal("Response").await?;
    let proxy = desktop_proxy(connection, interface).await?;
    let returned: OwnedObjectPath = match (method, session) {
        ("Start", Some(session)) => proxy.call(method, &(session, "", options)).await?,
        (_, Some(session)) => proxy.call(method, &(session, options)).await?,
        (_, None) => proxy.call(method, &(options,)).await?,
    };
    if returned.as_str() != path {
        return Err(malformed("portal returned an unexpected request path"));
    }
    let message = response.next().await.ok_or(Error::Stopped)?;
    let (code, properties): (u32, Properties) = message.body().deserialize()?;
    match code {
        0 => Ok(properties),
        1 => Err(Error::Cancelled),
        _ => Err(Error::PermissionDenied),
    }
}

fn unique_token() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("deskfleet_{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn malformed(message: &str) -> Error {
    Error::Unavailable(message.to_owned())
}

pub fn allocate_id(next: &mut u32) -> Result<u32> {
    let id = *next;
    *next = next
        .checked_add(1)
        .ok_or_else(|| malformed("source identifiers exhausted"))?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ids_do_not_repeat_after_a_session_is_replaced() {
        let mut next = 1;
        let old = [
            allocate_id(&mut next).unwrap(),
            allocate_id(&mut next).unwrap(),
        ];
        let replacement = allocate_id(&mut next).unwrap();
        assert!(!old.contains(&replacement));
        let mut exhausted = u32::MAX;
        assert!(allocate_id(&mut exhausted).is_err());
    }

    #[test]
    fn source_parser_retains_v6_serial_and_logical_mapping_with_v5_fallback() {
        let properties: Properties = HashMap::from([
            (
                "size".into(),
                Variant::from((1920i32, 1080i32)).try_to_owned().unwrap(),
            ),
            ("pipewire-serial".into(), OwnedVariant::from(u64::MAX - 1)),
            (
                "mapping_id".into(),
                Variant::from("monitor-b").try_to_owned().unwrap(),
            ),
        ]);
        // Exercise the actual a(ua{sv}) response conversion before parsing it.
        let wire = Variant::from(vec![(42u32, properties), (43, HashMap::new())])
            .try_to_owned()
            .unwrap();
        let streams = Vec::<(u32, Properties)>::try_from(wire).unwrap();
        let sources = parse_sources(streams, &mut 1).unwrap();
        assert_eq!((sources[0].width, sources[0].height), (1920, 1080));
        assert_eq!(sources[0].pipewire_serial, Some(u64::MAX - 1));
        assert_eq!(sources[0].mapping_id.as_deref(), Some("monitor-b"));
        assert_eq!(sources[1].pipewire_serial, None);
        assert_eq!(sources[1].node_id, 43);
        assert_ne!(sources[0].id, sources[1].id);
    }

    #[test]
    fn screen_capture_survives_when_pointer_regions_are_ambiguous() {
        let snapshot = granted_snapshot(true, false, true);
        assert!(snapshot.screen_capture);
        assert!(!snapshot.control);
        assert!(snapshot.persistent);
        assert_eq!(snapshot.status, PermissionStatus::Granted);
        assert!(!granted_snapshot(false, true, false).control);
    }
}
