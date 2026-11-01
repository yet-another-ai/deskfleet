//! Desktop-only IPC. Team authorization and WebRTC remain in the user daemon.

#[cfg(windows)]
mod client;
#[cfg_attr(not(windows), allow(dead_code))]
mod protocol;
#[cfg(windows)]
mod worker;

#[cfg(windows)]
pub(crate) use client::Client;
#[cfg(windows)]
pub use worker::serve;
