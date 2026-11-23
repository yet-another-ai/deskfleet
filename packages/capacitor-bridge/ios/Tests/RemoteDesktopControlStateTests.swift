import XCTest
@testable import DeskFleetLocalFiles

final class RemoteDesktopControlStateTests: XCTestCase {
    func testInitialSnapshotHasEveryControlFlagBeforeLayout() throws {
        let data = try JSONSerialization.data(withJSONObject: RemoteDesktopControlState().snapshot)
        let snapshot = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let ui = try XCTUnwrap(snapshot["ui"] as? [String: Any])
        XCTAssertEqual(ui["status"] as? String, "starting")
        for flag in ["control", "inputReady", "secureAttention"] {
            XCTAssertEqual(ui[flag] as? Bool, false, flag)
        }
        for flag in ["relativeMouse", "paused", "dragging", "keyboardOpen", "hackerOpen", "pasteShift", "reverseScroll"] {
            XCTAssertEqual(snapshot[flag] as? Bool, false, flag)
        }
        for flag in ["mobile", "clipboardSharing", "fullscreen", "pinchZoom"] {
            XCTAssertEqual(snapshot[flag] as? Bool, true, flag)
        }
        XCTAssertEqual(snapshot["modifiers"] as? [Bool], [false, false, false, false])
    }

    func testSnapshotUsesCurrentSessionAndFlagsWithoutALayoutPass() throws {
        var state = RemoteDesktopControlState(ui: ["status": "connected", "control": true,
                                                   "inputReady": true, "displayId": 3])
        let previous = state.snapshot
        state.ui["inputReady"] = false
        state.ui["displayId"] = 9
        state.paused = true
        state.relativeMouse = true
        state.dragging = true
        state.keyboardOpen = true
        state.hackerOpen = true
        state.pasteShift = true
        state.reverseScroll = true
        state.clipboardSharing = false
        state.fullscreen = false
        state.pinchZoom = false
        state.modifiers.apply([true, true, false, true])

        let snapshot = state.snapshot
        let ui = try XCTUnwrap(snapshot["ui"] as? [String: Any])
        XCTAssertEqual(ui["status"] as? String, "connected")
        XCTAssertEqual(ui["control"] as? Bool, true)
        XCTAssertEqual(ui["inputReady"] as? Bool, false)
        XCTAssertEqual(ui["displayId"] as? Int, 9)
        for flag in ["relativeMouse", "paused", "dragging", "keyboardOpen", "hackerOpen", "pasteShift", "reverseScroll"] {
            XCTAssertEqual(snapshot[flag] as? Bool, true, flag)
        }
        for flag in ["clipboardSharing", "fullscreen", "pinchZoom"] {
            XCTAssertEqual(snapshot[flag] as? Bool, false, flag)
        }
        XCTAssertEqual(snapshot["modifiers"] as? [Bool], [true, true, false, true])
        XCTAssertEqual((previous["ui"] as? [String: Any])?["inputReady"] as? Bool, true)
        XCTAssertEqual(previous["paused"] as? Bool, false)
    }
}
