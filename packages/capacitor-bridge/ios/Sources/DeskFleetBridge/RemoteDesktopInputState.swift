import Foundation

/// Tracks a direct-touch pan; session and pause transitions belong to Rust.
struct RemoteDesktopInputState {
    private var scrolling = false

    /// Once two fingers participate, lifting one cannot turn this gesture into a drag.
    mutating func scrollPan(touches: Int) -> Bool {
        scrolling = scrolling || touches >= 2
        return scrolling
    }

    mutating func endPan() { scrolling = false }
}
