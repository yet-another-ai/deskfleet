//! The viewer process owns ordered peer lifetimes behind one persistent UI.

use std::io::{self, BufRead};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, watch};

use crate::{Error, WindowEvent, WindowNotifier, input_queue, protocol, queue, session};

pub(crate) struct Host {
    pub(crate) frames: session::Frames,
    pub(crate) input: input_queue::Sender,
    pub(crate) shutdown: watch::Sender<bool>,
    runtime: tokio::runtime::Runtime,
    session: tokio::task::JoinHandle<Result<(), Error>>,
}

impl Host {
    pub(crate) fn start(proxy: WindowNotifier) -> Result<Self, Error> {
        let frames = Arc::new(Mutex::new(queue::FrameQueue::default()));
        let (commands_tx, commands) = mpsc::channel(32);
        let (input, inputs) = input_queue::channel();
        let (shutdown, shutdown_rx) = watch::channel(false);
        let reader_proxy = proxy.clone();
        std::thread::Builder::new()
            .name("viewer control".into())
            .spawn(move || {
                for line in io::stdin().lock().lines() {
                    let parsed = line.map_err(|error| error.to_string()).and_then(|line| {
                        serde_json::from_str(&line).map_err(|error| error.to_string())
                    });
                    match parsed {
                        Ok(command) => {
                            if commands_tx.blocking_send(command).is_err() {
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = reader_proxy.send_event(WindowEvent::Error(error));
                            return;
                        }
                    }
                }
                let _ = reader_proxy.send_event(WindowEvent::Close);
            })?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let session_frames = Arc::clone(&frames);
        let session = runtime.spawn(async move {
            let result =
                session::run(commands, inputs, session_frames, proxy.clone(), shutdown_rx).await;
            let event = match &result {
                Ok(()) => WindowEvent::Close,
                Err(error) => WindowEvent::Error(error.to_string()),
            };
            let _ = proxy.send_event(event);
            result
        });
        Ok(Self {
            frames,
            input,
            shutdown,
            runtime,
            session,
        })
    }

    pub(crate) fn finish(self) -> Result<(), Error> {
        self.shutdown.send_replace(true);
        let result = self.runtime.block_on(self.session);
        // The stdin reader is a detached ordinary thread and never holds up
        // Tokio shutdown when the user closes the native window.
        self.runtime.shutdown_timeout(Duration::from_secs(2));
        protocol::emit(json!({"type":"closed"}))?;
        result??;
        Ok(())
    }
}
