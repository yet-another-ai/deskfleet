import XCTest
@testable import DeskFleetLocalFiles

final class RemoteDesktopInputStateTests: XCTestCase {
    func testDisablingControlClearsPauseBeforeItCanBeEnabledAgain() {
        var state = RemoteDesktopInputState()
        state.paused = true
        XCTAssertFalse(state.reconcile(status: "connected", control: true, inputReady: true))
        XCTAssertTrue(state.reconcile(status: "connected", control: false, inputReady: true))
        XCTAssertFalse(state.paused)
        XCTAssertFalse(state.reconcile(status: "connected", control: true, inputReady: true))
        XCTAssertFalse(state.paused)
    }

    func testReconnectingOrLosingInputAcknowledgementClearsNativePauseGate() {
        for (status, ready) in [("connecting", true), ("connected", false)] {
            var state = RemoteDesktopInputState()
            state.paused = true
            XCTAssertTrue(state.reconcile(status: status, control: true, inputReady: ready))
            XCTAssertFalse(state.paused)
        }
    }

    func testScrollGestureDoesNotBecomeDragWhenOneFingerLifts() {
        var state = RemoteDesktopInputState()
        XCTAssertFalse(state.scrollPan(touches: 1))
        XCTAssertTrue(state.scrollPan(touches: 2))
        XCTAssertTrue(state.scrollPan(touches: 1))
        state.endPan()
        XCTAssertFalse(state.scrollPan(touches: 1))
    }
}
