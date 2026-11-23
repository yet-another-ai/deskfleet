//! The native viewer control policy. Each host applies the returned effects in
//! order on its UI thread, against the same window that supplied the snapshot.

mod action;
mod policy;

pub use action::{Action, Panel, Status, ToolbarAction};
pub use policy::{ControlState, Effect, HostEvent, InputAvailability, MODIFIERS};

use nsh_core::prelude::*;

/// Reduces the JSON contract shared by JNI, UIKit and NSH embedding clients.
pub fn effects_json(state: &str, action: &str) -> serde_json::Result<String> {
    let state: ControlState = serde_json::from_str(state)?;
    let action: Action<String, Vec<String>> = serde_json::from_str(action)?;
    serde_json::to_string(&state.effects(&action))
}

/// Actions from a DeskFleet viewer's controls.
#[module]
pub struct ViewerControls;

#[module]
impl ViewerControls {
    /// Computes ordered effects from the window snapshot and toolbar action JSON.
    pub fn effects(state: String, action: String) -> Result<String, String> {
        effects_json(&state, &action).map_err(|error| error.to_string())
    }
}

#[native_module("deskfleet-viewer-controls")]
fn native(registry: &mut Registry) {
    registry.module::<ViewerControls>();
}

#[cfg(test)]
mod tests;
