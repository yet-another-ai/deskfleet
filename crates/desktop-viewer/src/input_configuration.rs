//! Match live DesktopView settings on the existing ordered input channel.

use std::time::Duration;

use serde_json::json;
use tokio::time::Instant;

use crate::{Error, protocol};

#[derive(Default)]
pub(crate) struct Configuration {
    next: u64,
    pending: Option<(u64, Instant)>,
}

impl Configuration {
    pub(crate) fn request(&mut self, control: bool) -> Result<String, Error> {
        if self.pending.is_some() {
            return Err("desktop configuration already pending".into());
        }
        self.next += 1;
        self.pending = Some((self.next, Instant::now() + Duration::from_secs(10)));
        Ok(
            json!({"type":"configure", "requestId":self.next, "audio":false, "control":control})
                .to_string(),
        )
    }

    pub(crate) fn pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(crate) fn deadline(&self) -> Instant {
        self.pending
            .map_or_else(Instant::now, |(_, deadline)| deadline)
    }

    pub(crate) fn reply(
        &mut self,
        id: u64,
        control: bool,
        error: Option<String>,
    ) -> Result<bool, Error> {
        if !self.accept(id) {
            return Ok(false);
        }
        acknowledge(control, error)?;
        Ok(true)
    }

    fn accept(&mut self, id: u64) -> bool {
        if self.pending.is_some_and(|(pending, _)| pending == id) {
            self.pending = None;
            true
        } else {
            false
        }
    }

    pub(crate) fn timeout(&mut self) -> Result<(), Error> {
        self.pending = None;
        acknowledge(false, Some("Desktop settings update timed out".into()))
    }
}

fn acknowledge(control: bool, error: Option<String>) -> Result<(), Error> {
    let mut event = json!({"type":"controlConfigured", "control":control});
    if let Some(error) = error {
        event["error"] = error.into();
    }
    protocol::emit(event)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_configuration_reply_cannot_enable_a_new_request() {
        let mut state = Configuration::default();
        let first: serde_json::Value = serde_json::from_str(&state.request(true).unwrap()).unwrap();
        assert_eq!(first["audio"], false);
        assert!(state.request(false).is_err());
        assert!(state.accept(1));
        state.request(false).unwrap();
        assert!(!state.accept(1));
        assert!(state.pending());
        assert!(state.accept(2));
    }
}
