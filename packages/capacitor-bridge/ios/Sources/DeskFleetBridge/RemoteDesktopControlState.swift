import Foundation

/// The current platform state shared by the reducer and the Rust control surface.
/// Geometry, panels, and focus remain owned by the Rust overlay.
struct RemoteDesktopControlState {
    var ui: [String: Any] = [:]
    var relativeMouse = false
    var paused = false
    var dragging = false
    var keyboardOpen = false
    var hackerOpen = false
    var pasteShift = false
    var modifiers = RemoteDesktopModifiers()
    var reverseScroll = false
    var clipboardSharing = true
    var fullscreen = true
    var pinchZoom = true

    var snapshot: [String: Any] {
        var current: [String: Any] = ["status": "starting", "title": "", "displays": [], "displayId": 0,
                                      "control": false, "inputReady": false, "secureAttention": false]
        current.merge(ui) { _, next in next }
        return ["ui": current, "mobile": true, "relativeMouse": relativeMouse, "paused": paused,
                "dragging": dragging, "fullscreen": fullscreen, "keyboardOpen": keyboardOpen,
                "hackerOpen": hackerOpen, "pasteShift": pasteShift, "reverseScroll": reverseScroll,
                "clipboardSharing": clipboardSharing, "pinchZoom": pinchZoom, "modifiers": modifiers.flags]
    }
}
