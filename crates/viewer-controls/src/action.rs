use serde::{Deserialize, Serialize};

/// The toolbar's three dropdowns. At most one is open.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Panel {
    /// Input: pointer mode, keyboards, shortcuts, clipboard, and zoom.
    Control,
    /// Session: display, control permission, and connection.
    Config,
    /// Stream health: bitrate, frame rate, loss, and jitter.
    Monitor,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action<Key, Chord> {
    /// A new host UI snapshot replaced the previous one in this window.
    SessionChanged {
        was_enabled: bool,
        display_changed: bool,
    },
    ToggleControl,
    ToggleMouseMode,
    ToggleDrag,
    ToggleCollapsed,
    SyncClipboard,
    Close,
    ToggleKeyboard,
    ToggleHackerKeyboard,
    SetPasteShift(bool),
    ToggleModifier(Key),
    Key(Key),
    KeyboardMeasured(f32, f32),
    /// One complete chord. Earlier codes are held while the last is pressed.
    Shortcut(Chord),
    ToggleFullscreen,
    /// Opens a panel, or closes it when it is already open.
    TogglePanel(Panel),
    SelectDisplay(u32),
    SetControl(bool),
    SetReverseScroll(bool),
    SetClipboardSharing(bool),
    SetPinchZoom(bool),
    ResetZoom,
    SecureAttention,
    Reconnect,
    Disconnect,
    Measured(f32, f32),
    PanelMeasured(f32),
    FocusHandle,
    BlurHandle,
    SelectOpen(bool),
}

/// NSH callbacks borrow static key names from the keyboard and shortcuts.
pub type ToolbarAction = Action<&'static str, &'static [&'static str]>;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    #[default]
    Connecting,
    Starting,
    Connected,
    Disconnected,
    Error,
}
