import XCTest
@testable import DeskFleetLocalFiles

final class RemoteDesktopInputStateTests: XCTestCase {
    func testScrollGestureDoesNotBecomeDragWhenOneFingerLifts() {
        var state = RemoteDesktopInputState()
        XCTAssertFalse(state.scrollPan(touches: 1))
        XCTAssertTrue(state.scrollPan(touches: 2))
        XCTAssertTrue(state.scrollPan(touches: 1))
        state.endPan()
        XCTAssertFalse(state.scrollPan(touches: 1))
    }
}
