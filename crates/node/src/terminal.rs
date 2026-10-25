//! Thin async PTY binding. The daemon owns the returned terminal.

use std::collections::HashMap;

use deskfleet_native::terminal::{self, Terminal};
use napi::Result;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(object)]
pub struct TerminalConfig {
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
}

#[napi(object)]
pub struct TerminalEvent {
    pub kind: String,
    pub data: Option<Buffer>,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
}

impl From<terminal::TerminalEvent> for TerminalEvent {
    fn from(event: terminal::TerminalEvent) -> Self {
        let mut result = Self {
            kind: String::new(),
            data: None,
            exit_code: None,
            error: None,
        };
        match event {
            terminal::TerminalEvent::Data(data) => {
                result.kind = "data".into();
                result.data = Some(data.into());
            }
            terminal::TerminalEvent::Exit { exit_code } => {
                result.kind = "exit".into();
                result.exit_code = Some(exit_code);
            }
            terminal::TerminalEvent::Error(error) => {
                result.kind = "error".into();
                result.error = Some(error);
            }
        }
        result
    }
}

#[napi]
pub struct NativeTerminal {
    terminal: Terminal,
}

#[napi]
pub async fn create_terminal(config: TerminalConfig) -> Result<NativeTerminal> {
    let terminal = Terminal::spawn(terminal::TerminalConfig {
        cwd: config.cwd.into(),
        cols: config.cols,
        rows: config.rows,
        command: config.command,
        args: config.args.unwrap_or_default(),
        env: config.env.unwrap_or_default(),
    })
    .await
    .map_err(native_error)?;
    Ok(NativeTerminal { terminal })
}

#[napi]
impl NativeTerminal {
    #[napi]
    pub async fn write(&self, data: Buffer) -> Result<()> {
        self.terminal
            .write(data.to_vec())
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.terminal.resize(cols, rows).await.map_err(native_error)
    }

    /// Consume events in one daemon loop, independently of attached peers.
    #[napi]
    pub async fn next_event(&self) -> Result<Option<TerminalEvent>> {
        self.terminal
            .next_event()
            .await
            .map(|event| event.map(Into::into))
            .map_err(native_error)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.terminal.close().await.map_err(native_error)
    }
}
