import Foundation

/// Input transitions that must stay consistent with the Rust session gate.
struct RemoteDesktopInputState {
    var paused = false
    private var scrolling = false

    /// Returns true when the native pause gate must also be cleared.
    mutating func reconcile(status: String?, control: Bool, inputReady: Bool) -> Bool {
        guard paused && (status != "connected" || !control || !inputReady) else { return false }
        paused = false
        return true
    }

    /// Once two fingers participate, lifting one cannot turn this gesture into a drag.
    mutating func scrollPan(touches: Int) -> Bool {
        scrolling = scrolling || touches >= 2
        return scrolling
    }

    mutating func endPan() { scrolling = false }
}
