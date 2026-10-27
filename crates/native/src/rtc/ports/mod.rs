//! Peer-owned TCP forwarding. The reserved DataChannel is consumed directly in
//! Rust, keeping socket bytes out of the signaling event broadcast and napi.

mod connection;
mod wire;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState};

use super::{PeerError, PeerEvent, Result};
use connection::{Connection, Incoming};
use wire::{Frame, Target};

pub const CHANNEL: &str = "deskfleet-ports";
const CHUNK_BYTES: usize = 16 * 1024;
const WINDOW_CHUNKS: usize = 8;
const MAX_CONNECTIONS: usize = 32;
const COMMAND_CAPACITY: usize = 64;
// Budget one data window and one credit window per socket, plus lifecycle
// frames. Enqueue never blocks receive polling while the SCTP sender is full.
const OUTBOUND_CAPACITY: usize = MAX_CONNECTIONS * (2 * WINDOW_CHUNKS + 4);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

fn error(message: &'static str) -> PeerError {
    PeerError::PortForwarding(message)
}

#[derive(Clone, Copy)]
struct Deadline(Option<u64>);

impl Deadline {
    fn check(self) -> Result<()> {
        if let Some(expires) = self.0 {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| error("system clock is before the Unix epoch"))?;
            if now.as_millis() >= u128::from(expires) {
                return Err(error("authorization expired"));
            }
        }
        Ok(())
    }
}

enum Role {
    Initiator {
        listener: TcpListener,
        target: Target,
    },
    Responder {
        deadline: Deadline,
    },
}

#[derive(Default)]
struct State {
    role: Option<Role>,
    started: bool,
    closed: bool,
    task: Option<JoinHandle<()>>,
    stop: Option<oneshot::Sender<()>>,
}

/// Shared only with the native peer's incoming-channel handler.
#[derive(Clone, Default)]
pub(super) struct Forwarding(Arc<Mutex<State>>);

impl Forwarding {
    pub(super) async fn enable(&self, expires_at_ms: u64) -> Result<()> {
        let deadline = Deadline(Some(expires_at_ms));
        deadline.check()?;
        self.configure(Role::Responder { deadline }).await
    }

    pub(super) async fn listen(&self, local_port: u16, host: &str, port: u16) -> Result<u16> {
        let target = Target::new(host, port)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, local_port)).await?;
        let actual_port = listener.local_addr()?.port();
        self.configure(Role::Initiator { listener, target }).await?;
        Ok(actual_port)
    }

    async fn configure(&self, role: Role) -> Result<()> {
        let mut state = self.0.lock().await;
        if state.closed {
            return Err(PeerError::Closed);
        }
        if state.role.is_some() || state.started {
            return Err(error("already configured"));
        }
        state.role = Some(role);
        Ok(())
    }

    pub(super) async fn attach(
        &self,
        channel: Arc<dyn DataChannel>,
        events: broadcast::Sender<PeerEvent>,
    ) -> Result<()> {
        let mut state = self.0.lock().await;
        if state.closed {
            return Err(PeerError::Closed);
        }
        let role = state
            .role
            .take()
            .ok_or_else(|| error("channel is not authorized or already attached"))?;
        let (stop, stopped) = oneshot::channel();
        state.started = true;
        state.stop = Some(stop);
        state.task = Some(tokio::spawn(async move {
            let mut bridge = Bridge::new(role, Arc::clone(&channel));
            let result = tokio::select! {
                result = bridge.run(&events) => result,
                _ = stopped => Ok(()),
            };
            bridge.shutdown().await;
            if let Err(error) = result {
                let _ = events.send(PeerEvent::error(error.to_string()));
            }
            let _ = channel.close().await;
            let _ = events.send(PeerEvent::DataChannelClosed {
                label: CHANNEL.to_owned(),
            });
        }));
        Ok(())
    }

    pub(super) async fn close(&self) {
        let task = {
            let mut state = self.0.lock().await;
            state.closed = true;
            state.role.take();
            if let Some(stop) = state.stop.take() {
                let _ = stop.send(());
            }
            state.task.take()
        };
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

enum Command {
    Connected {
        id: u32,
        socket: std::io::Result<TcpStream>,
    },
    Frame(Frame),
    Done {
        id: u32,
        reset: bool,
    },
    TransportFailed(PeerError),
}

struct Task(JoinHandle<()>);

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Bridge {
    listener: Option<TcpListener>,
    target: Option<Target>,
    deadline: Deadline,
    channel: Arc<dyn DataChannel>,
    connections: HashMap<u32, Connection>,
    connecting: HashMap<u32, Task>,
    commands: mpsc::Sender<Command>,
    receiver: mpsc::Receiver<Command>,
    outbound: mpsc::Sender<Frame>,
    sender: Task,
    last_id: u32,
    opened: bool,
}

impl Bridge {
    fn new(role: Role, channel: Arc<dyn DataChannel>) -> Self {
        let (listener, target, deadline) = match role {
            Role::Initiator { listener, target } => (Some(listener), Some(target), Deadline(None)),
            Role::Responder { deadline } => (None, None, deadline),
        };
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (outbound, mut outgoing) = mpsc::channel(OUTBOUND_CAPACITY);
        let sender_channel = Arc::clone(&channel);
        let sender_commands = commands.clone();
        let sender = Task(tokio::spawn(async move {
            while let Some(frame) = outgoing.recv().await {
                if let Err(error) = send_frame(sender_channel.as_ref(), frame, deadline).await {
                    let _ = sender_commands.send(Command::TransportFailed(error)).await;
                    return;
                }
            }
        }));
        Self {
            listener,
            target,
            deadline,
            channel,
            connections: HashMap::new(),
            connecting: HashMap::new(),
            commands,
            receiver,
            outbound,
            sender,
            last_id: 0,
            opened: false,
        }
    }

    async fn run(&mut self, events: &broadcast::Sender<PeerEvent>) -> Result<()> {
        // Wall-clock rechecks also cover a machine resuming after its grant expired.
        let mut expiry = tokio::time::interval(Duration::from_millis(250));
        if self.channel.ready_state().await? == RTCDataChannelState::Open {
            self.open(events);
        }
        loop {
            self.deadline.check()?;
            tokio::select! {
                _ = expiry.tick() => {},
                event = self.channel.poll() => match event {
                    Some(DataChannelEvent::OnOpen) => self.open(events),
                    Some(DataChannelEvent::OnMessage(message)) => {
                        self.deadline.check()?;
                        if !self.opened { return Err(error("message before channel open")); }
                        self.receive(Frame::decode(message.data.freeze(), message.is_string)?).await?;
                    }
                    Some(DataChannelEvent::OnClose) | None => return Ok(()),
                    Some(DataChannelEvent::OnError) => return Err(error("data channel failed")),
                    Some(_) => {},
                },
                socket = accept(self.listener.as_ref()), if self.opened && self.listener.is_some() => {
                    let socket = socket?;
                    self.deadline.check()?;
                    if self.connections.len() >= MAX_CONNECTIONS { continue; }
                    self.last_id = self.last_id.checked_add(1).ok_or_else(|| error("connection IDs exhausted"))?;
                    let id = self.last_id;
                    socket.set_nodelay(true)?;
                    self.connections.insert(id, Connection::start(id, socket, false, self.deadline, self.commands.clone()));
                    self.send(Frame::Open(id, self.target.ok_or_else(|| error("missing target"))?))?;
                },
                command = self.receiver.recv() => {
                    if let Some(command) = command { self.command(command).await?; }
                },
            }
        }
    }

    fn open(&mut self, events: &broadcast::Sender<PeerEvent>) {
        if !self.opened {
            self.opened = true;
            let _ = events.send(PeerEvent::DataChannelOpen {
                label: CHANNEL.to_owned(),
            });
        }
    }

    async fn receive(&mut self, frame: Frame) -> Result<()> {
        let id = frame.id();
        match frame {
            Frame::Open(_, target) => {
                if self.listener.is_some() || id <= self.last_id {
                    return Err(error("unexpected or reused connection ID"));
                }
                self.last_id = id;
                if self.connections.len() + self.connecting.len() >= MAX_CONNECTIONS {
                    return self.send(Frame::Reset(id));
                }
                let commands = self.commands.clone();
                let deadline = self.deadline;
                let task = tokio::spawn(async move {
                    let socket = if deadline.check().is_err() {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "authorization expired",
                        ))
                    } else {
                        match tokio::time::timeout(
                            CONNECT_TIMEOUT,
                            TcpStream::connect(target.address()),
                        )
                        .await
                        {
                            Ok(value) => value,
                            Err(_) => Err(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "connect timed out",
                            )),
                        }
                    };
                    let _ = commands.send(Command::Connected { id, socket }).await;
                });
                self.connecting.insert(id, Task(task));
            }
            Frame::Reset(_) => {
                self.close_connection(id).await;
                self.connecting.remove(&id);
            }
            frame => {
                // Reset and completed sockets can have credits already in flight.
                let Some(connection) = self.connections.get_mut(&id) else {
                    return Ok(());
                };
                let result = match frame {
                    Frame::Opened(_) if self.listener.is_some() => connection.opened(),
                    Frame::Data(_, data) => connection.receive(Incoming::Data(data)),
                    Frame::Fin(_) => connection.receive(Incoming::Fin),
                    Frame::Window(_) => connection.window(),
                    _ => Err(error("unexpected connection frame")),
                };
                if result.is_err() {
                    self.close_connection(id).await;
                    self.send(Frame::Reset(id))?;
                }
            }
        }
        Ok(())
    }

    async fn command(&mut self, command: Command) -> Result<()> {
        self.deadline.check()?;
        match command {
            Command::Connected { id, socket } => {
                if self.connecting.remove(&id).is_none() {
                    return Ok(());
                }
                match socket {
                    Ok(socket) => {
                        socket.set_nodelay(true)?;
                        self.send(Frame::Opened(id))?;
                        self.connections.insert(
                            id,
                            Connection::start(
                                id,
                                socket,
                                true,
                                self.deadline,
                                self.commands.clone(),
                            ),
                        );
                    }
                    Err(_) => self.send(Frame::Reset(id))?,
                }
            }
            Command::Frame(frame) => {
                if self.connections.contains_key(&frame.id()) {
                    self.send(frame)?;
                }
            }
            Command::Done { id, reset } => {
                if self.close_connection(id).await && reset {
                    self.send(Frame::Reset(id))?;
                }
            }
            Command::TransportFailed(error) => return Err(error),
        }
        Ok(())
    }

    fn send(&self, frame: Frame) -> Result<()> {
        self.deadline.check()?;
        self.outbound
            .try_send(frame)
            .map_err(|_| error("outbound frame budget exceeded"))
    }

    async fn close_connection(&mut self, id: u32) -> bool {
        let Some(mut connection) = self.connections.remove(&id) else {
            return false;
        };
        connection.task.abort();
        let _ = (&mut connection.task).await;
        true
    }

    async fn shutdown(&mut self) {
        self.listener.take();
        self.sender.0.abort();
        let _ = (&mut self.sender.0).await;
        for (_, connection) in self.connections.drain() {
            connection.task.abort();
            // The socket halves are dropped before peer.close resolves.
            let mut connection = connection;
            let _ = (&mut connection.task).await;
        }
        for (_, mut connecting) in self.connecting.drain() {
            connecting.0.abort();
            let _ = (&mut connecting.0).await;
        }
        self.receiver.close();
        while self.receiver.try_recv().is_ok() {}
    }
}

async fn send_frame(channel: &dyn DataChannel, frame: Frame, deadline: Deadline) -> Result<()> {
    let bytes = frame.encode();
    let until = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        deadline.check()?;
        match channel.try_send(bytes.clone()).await {
            Ok(_) => return Ok(()),
            Err(webrtc::error::Error::ErrSendBufferFull) if tokio::time::Instant::now() < until => {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

async fn accept(listener: Option<&TcpListener>) -> std::io::Result<TcpStream> {
    match listener {
        Some(listener) => listener.accept().await.map(|(socket, _)| socket),
        None => std::future::pending().await,
    }
}
