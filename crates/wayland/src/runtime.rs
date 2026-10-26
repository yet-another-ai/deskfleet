use std::{
    os::fd::OwnedFd,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
};

use futures_util::StreamExt;
use tokio::sync::{Notify, mpsc, oneshot};

use crate::{
    Error, PermissionSnapshot, PermissionStatus, Result, Source,
    input::Action,
    portal::{self, Live},
};

type Reply<T> = oneshot::Sender<Result<T>>;

enum Command {
    Request(Option<PathBuf>, Reply<PermissionSnapshot>),
    Shutdown(Reply<()>),
    Open(u32, Reply<(OwnedFd, Source)>),
    Attach(u64, u32, Reply<()>),
    Input(u64, Action, Reply<()>),
    Detach(u64),
}

#[derive(Default)]
struct Observed {
    snapshot: PermissionSnapshot,
    sources: Vec<Source>,
}

struct Handle {
    commands: mpsc::UnboundedSender<Command>,
    observed: Arc<Mutex<Observed>>,
}

static RUNTIME: OnceLock<std::result::Result<Handle, String>> = OnceLock::new();
static ACCESS_GENERATION: AtomicU32 = AtomicU32::new(0);
/// Bumped by shutdown. A watch ends only when this changes after it starts.
static ACCESS_EPOCH: AtomicU32 = AtomicU32::new(0);
static ACCESS_CHANGED: Notify = Notify::const_new();

fn handle() -> Result<&'static Handle> {
    RUNTIME
        .get_or_init(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            let (commands, receiver) = mpsc::unbounded_channel();
            let observed = Arc::new(Mutex::new(Observed::default()));
            let state = observed.clone();
            std::thread::Builder::new()
                .name("deskfleet-wayland".into())
                .spawn(move || runtime.block_on(run(receiver, state, PortalAuthorizer)))
                .map_err(|error| error.to_string())?;
            Ok(Handle { commands, observed })
        })
        .as_ref()
        .map_err(|error| Error::Unavailable(error.clone()))
}

fn send(command: Command) -> Result<()> {
    handle()?.commands.send(command).map_err(|_| Error::Stopped)
}

pub async fn request(directory: Option<PathBuf>) -> Result<PermissionSnapshot> {
    let (reply, response) = oneshot::channel();
    send(Command::Request(directory, reply))?;
    response.await.map_err(|_| Error::Stopped)?
}

pub fn snapshot() -> PermissionSnapshot {
    let Some(Ok(handle)) = RUNTIME.get() else {
        return PermissionSnapshot::default();
    };
    handle
        .observed
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .snapshot
        .clone()
}

pub fn sources() -> Result<Vec<Source>> {
    let Some(Ok(handle)) = RUNTIME.get() else {
        return Err(Error::PermissionDenied);
    };
    let state = handle
        .observed
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !state.snapshot.screen_capture {
        return Err(Error::PermissionDenied);
    }
    Ok(state.sources.clone())
}

pub async fn shutdown() -> Result<()> {
    let result = async {
        if RUNTIME.get().is_none() {
            return Ok(());
        }
        let (reply, response) = oneshot::channel();
        send(Command::Shutdown(reply))?;
        response.await.map_err(|_| Error::Stopped)?
    }
    .await;
    // End watches that are already waiting. A later watch reads the new epoch.
    ACCESS_EPOCH.fetch_add(1, Ordering::Release);
    ACCESS_CHANGED.notify_waiters();
    result
}

pub async fn wait_for_access_change(seen: u32) -> Option<u32> {
    let started = ACCESS_EPOCH.load(Ordering::Acquire);
    wait_for_generation(
        seen,
        &ACCESS_GENERATION,
        &ACCESS_EPOCH,
        started,
        &ACCESS_CHANGED,
    )
    .await
}

pub fn open_pipewire(id: u32) -> Result<(OwnedFd, Source)> {
    let (reply, response) = oneshot::channel();
    send(Command::Open(id, reply))?;
    response.blocking_recv().map_err(|_| Error::Stopped)?
}

pub fn attach(source: u32) -> Result<u64> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| Error::Stopped)?;
    let (reply, response) = oneshot::channel();
    send(Command::Attach(id, source, reply))?;
    response.blocking_recv().map_err(|_| Error::Stopped)??;
    Ok(id)
}

pub fn input(id: u64, action: Action) -> Result<()> {
    let (reply, response) = oneshot::channel();
    send(Command::Input(id, action, reply))?;
    response.blocking_recv().map_err(|_| Error::Stopped)?
}

pub fn detach(id: u64) {
    if let Some(Ok(handle)) = RUNTIME.get() {
        let _ = handle.commands.send(Command::Detach(id));
    }
}

fn observe(observed: &Mutex<Observed>, snapshot: PermissionSnapshot, sources: Vec<Source>) {
    let changed = {
        let mut state = observed.lock().unwrap_or_else(|error| error.into_inner());
        let changed = access_changed(&state, &snapshot, &sources);
        *state = Observed { snapshot, sources };
        changed
    };
    if changed {
        publish_generation(&ACCESS_GENERATION, &ACCESS_CHANGED);
    }
}

fn access_changed(current: &Observed, snapshot: &PermissionSnapshot, sources: &[Source]) -> bool {
    current.snapshot != *snapshot || current.sources != sources
}

fn publish_generation(generation: &AtomicU32, notify: &Notify) {
    generation.fetch_add(1, Ordering::Release);
    notify.notify_waiters();
}

async fn wait_for_generation(
    seen: u32,
    generation: &AtomicU32,
    epoch: &AtomicU32,
    started: u32,
    notify: &Notify,
) -> Option<u32> {
    loop {
        let notified = notify.notified();
        tokio::pin!(notified);
        if epoch.load(Ordering::Acquire) != started {
            return None;
        }
        let current = generation.load(Ordering::Acquire);
        if current != seen {
            return Some(current);
        }
        notified.as_mut().enable();
        if epoch.load(Ordering::Acquire) != started {
            return None;
        }
        let current = generation.load(Ordering::Acquire);
        if current != seen {
            return Some(current);
        }
        notified.await;
    }
}

/// An explicit request retries EIS only while capture is up and input is down.
fn should_retry_remote_input(
    explicit_request: bool,
    input_connected: bool,
    screen_capture: bool,
) -> bool {
    explicit_request && !input_connected && screen_capture
}

fn apply_remote_input(snapshot: &mut PermissionSnapshot, controllable: bool) {
    snapshot.control = snapshot.screen_capture && controllable;
}

/// EIS failure drops remote control and leaves the granted capture sources in place.
fn keep_capture(snapshot: PermissionSnapshot, sources: Vec<Source>) -> Observed {
    Observed {
        snapshot: PermissionSnapshot {
            control: false,
            ..snapshot
        },
        sources,
    }
}

fn share_error(error: &Error) -> Error {
    match error {
        Error::Unavailable(message) => Error::Unavailable(message.clone()),
        Error::Cancelled => Error::Cancelled,
        Error::PermissionDenied => Error::PermissionDenied,
        Error::Busy => Error::Busy,
        Error::StaleSource => Error::StaleSource,
        Error::InvalidInput(message) => Error::InvalidInput(message),
        Error::Portal(error) => Error::Portal(error.clone()),
        Error::Response(error) => Error::Response(error.clone()),
        Error::Io(error) => Error::Unavailable(error.to_string()),
        Error::Input(message) => Error::Input(message.clone()),
        Error::Stopped => Error::Stopped,
    }
}

fn clear(observed: &Mutex<Observed>, status: PermissionStatus) {
    observe(
        observed,
        PermissionSnapshot {
            status,
            ..PermissionSnapshot::default()
        },
        Vec::new(),
    );
}

async fn run(
    mut receiver: mpsc::UnboundedReceiver<Command>,
    observed: Arc<Mutex<Observed>>,
    mut authorizer: impl Authorizer,
) {
    let mut live: Option<Live> = None;
    let mut directory = None;
    let mut next_source = 1;
    loop {
        let command = if let Some(session) = live.as_mut() {
            tokio::select! {
                command = receiver.recv() => command,
                _ = session.closed.next() => {
                    tracing::info!("Wayland portal session closed");
                    None
                },
                _ = session.owner_changed.next() => {
                    tracing::info!("Wayland portal service changed owner");
                    None
                },
                event = next_input(&mut session.input) => {
                    let result = match event {
                        Some(Ok(event)) => session.input.as_mut().ok_or(Error::Stopped).and_then(|input| input.event(event)),
                        Some(Err(error)) => Err(Error::Input(error.to_string())),
                        None => Err(Error::Input("the compositor disconnected remote input".into())),
                    };
                    if let Err(error) = result {
                        tracing::warn!(%error, "Wayland remote input ended; screen capture remains active");
                        let retained = keep_capture(session.snapshot.clone(), session.sources.clone());
                        if let Some(mut input) = session.input.take() {
                            let _ = input.detach();
                        }
                        session.snapshot = retained.snapshot.clone();
                        observe(&observed, retained.snapshot, retained.sources);
                    }
                    continue;
                }
            }
        } else {
            receiver.recv().await
        };
        let Some(command) = command else {
            clear(&observed, PermissionStatus::Unavailable);
            if let Some(session) = live.take() {
                session.close().await;
            }
            if receiver.is_closed() {
                break;
            }
            continue;
        };
        match command {
            Command::Request(requested_directory, reply) => {
                if let Some(session) = live.as_mut() {
                    // A dropped handshake stays on this session. Retry it only for an
                    // explicit request so display listing does not wait on EIS.
                    if should_retry_remote_input(
                        requested_directory.is_some(),
                        session.input.is_some(),
                        session.snapshot.screen_capture,
                    ) {
                        let input =
                            portal::connect_input(&session.connection, &session.session).await;
                        let controllable = input.as_ref().is_some_and(|input| {
                            session.sources.iter().any(|source| input.controls(source))
                        });
                        apply_remote_input(&mut session.snapshot, controllable);
                        session.input = input;
                        observe(&observed, session.snapshot.clone(), session.sources.clone());
                    }
                    let _ = reply.send(Ok(session.snapshot.clone()));
                    continue;
                }
                let restore_only = requested_directory.is_none();
                if let Some(requested) = requested_directory {
                    directory = Some(requested);
                }
                let Some(request_directory) = directory.as_deref() else {
                    let _ = reply.send(Err(Error::PermissionDenied));
                    continue;
                };
                clear(&observed, PermissionStatus::Requesting);
                let outcome = authorizer
                    .authorize(
                        request_directory,
                        restore_only,
                        &mut next_source,
                        &mut receiver,
                    )
                    .await;
                if outcome.shutdown.is_some() {
                    directory = None;
                }
                match outcome.result {
                    Ok(session) => {
                        observe(&observed, session.snapshot.clone(), session.sources.clone());
                        let snapshot = session.snapshot.clone();
                        let _ = reply.send(Ok(snapshot.clone()));
                        for waiter in outcome.waiting {
                            let _ = waiter.send(Ok(snapshot.clone()));
                        }
                        live = Some(session);
                    }
                    Err(error) => {
                        let status = if outcome.shutdown.is_some() {
                            PermissionStatus::Unknown
                        } else if matches!(error, Error::Cancelled | Error::PermissionDenied) {
                            PermissionStatus::Denied
                        } else {
                            PermissionStatus::Unavailable
                        };
                        clear(&observed, status);
                        for waiter in outcome.waiting {
                            let _ = waiter.send(Err(share_error(&error)));
                        }
                        let _ = reply.send(Err(error));
                    }
                }
                if let Some(shutdown) = outcome.shutdown {
                    let _ = shutdown.send(Ok(()));
                }
            }
            Command::Shutdown(reply) => {
                directory = None;
                clear(&observed, PermissionStatus::Unknown);
                if let Some(session) = live.take() {
                    session.close().await;
                }
                let _ = reply.send(Ok(()));
            }
            Command::Open(id, reply) => {
                let result = if let Some(session) = live.as_ref() {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        session.open_pipewire(id),
                    )
                    .await
                    .unwrap_or(Err(Error::Stopped))
                } else {
                    Err(Error::PermissionDenied)
                };
                let _ = reply.send(result);
            }
            Command::Attach(id, source_id, reply) => {
                let result = live
                    .as_mut()
                    .ok_or(Error::PermissionDenied)
                    .and_then(|session| {
                        let source = session
                            .sources
                            .iter()
                            .find(|source| source.id == source_id)
                            .ok_or(Error::StaleSource)?
                            .clone();
                        session
                            .input
                            .as_mut()
                            .ok_or(Error::PermissionDenied)?
                            .attach(id, source)
                    });
                let _ = reply.send(result);
            }
            Command::Input(id, action, reply) => {
                let result =
                    if let Some(input) = live.as_mut().and_then(|session| session.input.as_mut()) {
                        input.action(id, action)
                    } else if matches!(
                        action,
                        Action::Release
                            | Action::Key { pressed: false, .. }
                            | Action::Button { pressed: false, .. }
                    ) {
                        Ok(())
                    } else {
                        Err(Error::PermissionDenied)
                    };
                let _ = reply.send(result);
            }
            Command::Detach(id) => {
                if let Some(input) = live.as_mut().and_then(|session| session.input.as_mut()) {
                    let _ = input.detach_controller(id);
                }
            }
        }
    }
}

async fn next_input(
    input: &mut Option<crate::input::Eis>,
) -> Option<std::result::Result<reis::event::EiEvent, reis::Error>> {
    match input {
        Some(input) => input.events.next().await,
        None => std::future::pending().await,
    }
}

struct AuthorizationOutcome {
    result: Result<Live>,
    shutdown: Option<Reply<()>>,
    /// Display discovery and other restores that arrived while consent was open.
    waiting: Vec<Reply<PermissionSnapshot>>,
}

trait Authorizer {
    async fn authorize(
        &mut self,
        directory: &std::path::Path,
        restore_only: bool,
        next_source: &mut u32,
        receiver: &mut mpsc::UnboundedReceiver<Command>,
    ) -> AuthorizationOutcome;
}

struct PortalAuthorizer;

impl Authorizer for PortalAuthorizer {
    async fn authorize(
        &mut self,
        directory: &std::path::Path,
        restore_only: bool,
        next_source: &mut u32,
        receiver: &mut mpsc::UnboundedReceiver<Command>,
    ) -> AuthorizationOutcome {
        let mut connection = None;
        let outcome = {
            let authorization =
                portal::authorize(directory, restore_only, &mut connection, next_source);
            pending_authorization(authorization, receiver).await
        };
        if outcome.result.is_err()
            && let Some(connection) = connection
        {
            let _ = connection.close().await;
        }
        outcome
    }
}

async fn pending_authorization(
    authorization: impl std::future::Future<Output = Result<Live>>,
    receiver: &mut mpsc::UnboundedReceiver<Command>,
) -> AuthorizationOutcome {
    let mut shutdown = None;
    let mut waiting = Vec::new();
    tokio::pin!(authorization);
    let result = {
        loop {
            tokio::select! {
                result = &mut authorization => break result,
                command = receiver.recv() => match command {
                    Some(Command::Shutdown(reply)) => { shutdown = Some(reply); break Err(Error::Cancelled); }
                    // The startup dialog already owns this connection. Listing displays
                    // waits for its result instead of failing the refresh as busy.
                    Some(Command::Request(_, reply)) => waiting.push(reply),
                    Some(Command::Open(_, reply)) => { let _ = reply.send(Err(Error::PermissionDenied)); }
                    Some(Command::Attach(_, _, reply)) => { let _ = reply.send(Err(Error::PermissionDenied)); }
                    Some(Command::Input(_, action, reply)) => {
                        let released = matches!(action, Action::Release | Action::Key { pressed: false, .. } | Action::Button { pressed: false, .. });
                        let _ = reply.send(if released { Ok(()) } else { Err(Error::PermissionDenied) });
                    }
                    Some(Command::Detach(_)) => {}
                    None => break Err(Error::Stopped),
                }
            }
        }
    };
    AuthorizationOutcome {
        result,
        shutdown,
        waiting,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeAuthorizer {
        calls: Arc<AtomicUsize>,
        pending: bool,
    }

    impl Authorizer for FakeAuthorizer {
        async fn authorize(
            &mut self,
            _: &std::path::Path,
            _: bool,
            _: &mut u32,
            receiver: &mut mpsc::UnboundedReceiver<Command>,
        ) -> AuthorizationOutcome {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.pending {
                pending_authorization(std::future::pending(), receiver).await
            } else {
                AuthorizationOutcome {
                    result: Err(Error::PermissionDenied),
                    shutdown: None,
                    waiting: Vec::new(),
                }
            }
        }
    }

    async fn shutdown_prevents_late_restore(pending: bool) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let observed = Arc::new(Mutex::new(Observed::default()));
        let calls = Arc::new(AtomicUsize::new(0));
        let fake = FakeAuthorizer {
            calls: calls.clone(),
            pending,
        };
        let actor = run(receiver, observed.clone(), fake);
        let client = async {
            let (reply, first) = oneshot::channel();
            sender
                .send(Command::Request(
                    Some(PathBuf::from("/unused-test-directory")),
                    reply,
                ))
                .unwrap();
            let (reply, closed) = oneshot::channel();
            sender.send(Command::Shutdown(reply)).unwrap();
            assert!(first.await.unwrap().is_err());
            closed.await.unwrap().unwrap();
            let (reply, restored) = oneshot::channel();
            sender.send(Command::Request(None, reply)).unwrap();
            assert!(matches!(
                restored.await.unwrap(),
                Err(Error::PermissionDenied)
            ));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            assert_eq!(
                observed.lock().unwrap().snapshot.status,
                PermissionStatus::Unknown
            );
            drop(sender);
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(actor, client);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn shutdown_cancels_pending_authorization_and_disables_restore() {
        shutdown_prevents_late_restore(true).await;
    }

    #[tokio::test]
    async fn shutdown_clears_previous_configuration_before_late_restore() {
        shutdown_prevents_late_restore(false).await;
    }

    #[tokio::test]
    async fn display_listing_waits_for_the_open_consent_dialog() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let observed = Arc::new(Mutex::new(Observed::default()));
        let calls = Arc::new(AtomicUsize::new(0));
        let (release, grant) = oneshot::channel();
        let actor = run(
            receiver,
            observed.clone(),
            DeferredAuthorizer {
                calls: calls.clone(),
                release: Some(grant),
            },
        );
        let client = async {
            let (reply, first) = oneshot::channel();
            sender
                .send(Command::Request(
                    Some(PathBuf::from("/unused-test-directory")),
                    reply,
                ))
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
            while calls.load(Ordering::Relaxed) == 0 {
                if std::time::Instant::now() > deadline {
                    panic!("authorization did not start");
                }
                tokio::task::yield_now().await;
            }
            let (reply, mut listing) = oneshot::channel();
            sender.send(Command::Request(None, reply)).unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            assert!(
                matches!(listing.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
                "display listing must wait while consent is open"
            );
            release.send(()).unwrap();
            assert!(matches!(first.await.unwrap(), Err(Error::PermissionDenied)));
            assert!(matches!(
                listing.await.unwrap(),
                Err(Error::PermissionDenied)
            ));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            assert_eq!(
                observed.lock().unwrap().snapshot.status,
                PermissionStatus::Denied
            );
            drop(sender);
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(actor, client);
        })
        .await
        .unwrap();
    }

    #[test]
    fn input_disconnect_keeps_capture_sources() {
        let retained = keep_capture(
            PermissionSnapshot {
                screen_capture: true,
                control: true,
                status: PermissionStatus::Granted,
                persistent: true,
            },
            vec![Source {
                id: 4,
                name: "Display 1".into(),
                width: 1920,
                height: 1080,
                node_id: 7,
                pipewire_serial: None,
                mapping_id: None,
            }],
        );
        assert!(retained.snapshot.screen_capture);
        assert!(!retained.snapshot.control);
        assert_eq!(retained.snapshot.status, PermissionStatus::Granted);
        assert!(retained.snapshot.persistent);
        assert_eq!(retained.sources.len(), 1);
        assert_eq!(retained.sources[0].id, 4);
        assert_eq!(retained.sources[0].node_id, 7);
    }

    #[test]
    fn explicit_access_retries_remote_input_only_while_capture_lacks_it() {
        assert!(should_retry_remote_input(true, false, true));
        assert!(!should_retry_remote_input(false, false, true));
        assert!(!should_retry_remote_input(true, true, true));
        assert!(!should_retry_remote_input(true, false, false));
    }

    #[test]
    fn resumed_input_restores_control_only_when_a_source_is_controllable() {
        let mut snapshot = PermissionSnapshot {
            screen_capture: true,
            control: false,
            status: PermissionStatus::Granted,
            persistent: true,
        };
        apply_remote_input(&mut snapshot, false);
        assert!(snapshot.screen_capture);
        assert!(!snapshot.control);
        assert_eq!(snapshot.status, PermissionStatus::Granted);
        apply_remote_input(&mut snapshot, true);
        assert!(snapshot.control);
        snapshot.screen_capture = false;
        apply_remote_input(&mut snapshot, true);
        assert!(!snapshot.control);
    }

    #[test]
    fn permission_publication_tracks_input_loss_without_repeating() {
        let source = Source {
            id: 4,
            name: "Display 1".into(),
            width: 1920,
            height: 1080,
            node_id: 7,
            pipewire_serial: None,
            mapping_id: None,
        };
        let granted = Observed {
            snapshot: PermissionSnapshot {
                screen_capture: true,
                control: true,
                status: PermissionStatus::Granted,
                persistent: true,
            },
            sources: vec![source],
        };
        let lost = keep_capture(granted.snapshot.clone(), granted.sources.clone());
        assert!(access_changed(&granted, &lost.snapshot, &lost.sources));
        assert!(!lost.snapshot.control);
        assert!(lost.snapshot.screen_capture);
        assert!(!access_changed(&lost, &lost.snapshot, &lost.sources));
    }

    #[tokio::test]
    async fn published_access_change_wakes_a_waiter_and_close_ends_only_that_watch() {
        let generation = AtomicU32::new(0);
        let epoch = AtomicU32::new(0);
        let notify = Notify::new();
        let waiting = wait_for_generation(0, &generation, &epoch, 0, &notify);
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("access watch resolved before a change"),
            _ = tokio::task::yield_now() => {}
        }
        publish_generation(&generation, &notify);
        assert_eq!(waiting.await, Some(1));

        let waiting = wait_for_generation(1, &generation, &epoch, 0, &notify);
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("access watch resolved before shutdown"),
            _ = tokio::task::yield_now() => {}
        }
        epoch.fetch_add(1, Ordering::Release);
        notify.notify_waiters();
        assert_eq!(waiting.await, None);

        let started = epoch.load(Ordering::Acquire);
        let waiting = wait_for_generation(1, &generation, &epoch, started, &notify);
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("a watch started after shutdown resolved immediately"),
            _ = tokio::task::yield_now() => {}
        }
        publish_generation(&generation, &notify);
        assert_eq!(waiting.await, Some(2));
    }

    struct DeferredAuthorizer {
        calls: Arc<AtomicUsize>,
        release: Option<oneshot::Receiver<()>>,
    }

    impl Authorizer for DeferredAuthorizer {
        async fn authorize(
            &mut self,
            _: &std::path::Path,
            _: bool,
            _: &mut u32,
            receiver: &mut mpsc::UnboundedReceiver<Command>,
        ) -> AuthorizationOutcome {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let release = self.release.take().unwrap();
            let authorization = async move {
                release.await.unwrap();
                Err(Error::PermissionDenied)
            };
            pending_authorization(authorization, receiver).await
        }
    }
}
