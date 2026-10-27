//! Each socket owns two independent halves. Credits are returned only after a
//! received chunk has been written, so a slow TCP consumer stalls its sender.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;

use super::wire::Frame;
use super::{CHUNK_BYTES, Command, Deadline, WINDOW_CHUNKS, error};
use crate::rtc::Result;

pub(super) enum Incoming {
    Data(Bytes),
    Fin,
}

pub(super) struct Connection {
    pub(super) incoming: mpsc::Sender<Incoming>,
    pub(super) credits: Arc<Semaphore>,
    pub(super) outstanding: Arc<AtomicUsize>,
    pub(super) allowance: Arc<AtomicUsize>,
    pub(super) opened: bool,
    pub(super) remote_fin: bool,
    pub(super) task: JoinHandle<()>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Connection {
    pub(super) fn start(
        id: u32,
        socket: TcpStream,
        opened: bool,
        deadline: Deadline,
        commands: mpsc::Sender<Command>,
    ) -> Self {
        let (incoming, receiver) = mpsc::channel(WINDOW_CHUNKS + 1);
        let credits = Arc::new(Semaphore::new(if opened { WINDOW_CHUNKS } else { 0 }));
        let outstanding = Arc::new(AtomicUsize::new(0));
        let allowance = Arc::new(AtomicUsize::new(WINDOW_CHUNKS));
        let task = tokio::spawn(pump(
            id,
            socket,
            receiver,
            Arc::clone(&credits),
            Arc::clone(&outstanding),
            Arc::clone(&allowance),
            deadline,
            commands,
        ));
        Self {
            incoming,
            credits,
            outstanding,
            allowance,
            opened,
            remote_fin: false,
            task,
        }
    }

    pub(super) fn opened(&mut self) -> Result<()> {
        if self.opened {
            return Err(error("duplicate open acknowledgement"));
        }
        self.opened = true;
        self.credits.add_permits(WINDOW_CHUNKS);
        Ok(())
    }

    pub(super) fn window(&self) -> Result<()> {
        self.outstanding
            .try_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_sub(1)
            })
            .map_err(|_| error("unexpected flow-control credit"))?;
        self.credits.add_permits(1);
        Ok(())
    }

    pub(super) fn receive(&mut self, value: Incoming) -> Result<()> {
        if !self.opened || self.remote_fin {
            return Err(error("data before open or after half-close"));
        }
        match &value {
            Incoming::Data(_) => {
                self.allowance
                    .try_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                        value.checked_sub(1)
                    })
                    .map_err(|_| error("receive window exceeded"))?;
            }
            Incoming::Fin => self.remote_fin = true,
        }
        self.incoming
            .try_send(value)
            .map_err(|_| error("socket receive queue unavailable"))
    }
}

#[allow(clippy::too_many_arguments)]
async fn pump(
    id: u32,
    socket: TcpStream,
    mut incoming: mpsc::Receiver<Incoming>,
    credits: Arc<Semaphore>,
    outstanding: Arc<AtomicUsize>,
    allowance: Arc<AtomicUsize>,
    deadline: Deadline,
    commands: mpsc::Sender<Command>,
) {
    let (mut reader, mut writer) = socket.into_split();
    let read = async {
        let mut bytes = vec![0; CHUNK_BYTES];
        loop {
            let permit = credits
                .acquire()
                .await
                .map_err(|_| error("socket closed"))?;
            deadline.check()?;
            let count = reader.read(&mut bytes).await?;
            deadline.check()?;
            if count == 0 {
                commands
                    .send(Command::Frame(Frame::Fin(id)))
                    .await
                    .map_err(|_| error("peer closed"))?;
                return Ok::<_, crate::rtc::PeerError>(());
            }
            permit.forget();
            outstanding.fetch_add(1, Ordering::Release);
            commands
                .send(Command::Frame(Frame::Data(
                    id,
                    Bytes::copy_from_slice(&bytes[..count]),
                )))
                .await
                .map_err(|_| error("peer closed"))?;
        }
    };
    let write = async {
        while let Some(value) = incoming.recv().await {
            deadline.check()?;
            match value {
                Incoming::Data(data) => {
                    let mut remaining = data.as_ref();
                    while !remaining.is_empty() {
                        deadline.check()?;
                        let count = writer.write(remaining).await?;
                        if count == 0 {
                            return Err(error("socket write returned zero"));
                        }
                        remaining = &remaining[count..];
                    }
                    deadline.check()?;
                    allowance.fetch_add(1, Ordering::Release);
                    commands
                        .send(Command::Frame(Frame::Window(id)))
                        .await
                        .map_err(|_| error("peer closed"))?;
                }
                Incoming::Fin => {
                    writer.shutdown().await?;
                    return Ok::<_, crate::rtc::PeerError>(());
                }
            }
        }
        Err(error("peer closed"))
    };
    let reset = tokio::try_join!(read, write).is_err();
    let _ = commands.send(Command::Done { id, reset }).await;
}
