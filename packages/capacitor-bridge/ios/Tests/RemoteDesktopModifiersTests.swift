import XCTest
@testable import DeskFleetLocalFiles

final class RemoteDesktopModifiersTests: XCTestCase {
    func testChordUsesStableOrderAndConsumesOneShotModifiers() {
        var modifiers = RemoteDesktopModifiers()
        modifiers.apply([true, false, true, true])
        XCTAssertEqual(modifiers.take(), ["ControlLeft", "ShiftLeft", "MetaLeft"])
        XCTAssertTrue(modifiers.selected.isEmpty)
        XCTAssertTrue(modifiers.take().isEmpty)
    }

    func testReducerFlagsReplaceSelectionInControlAltShiftMetaOrder() {
        var modifiers = RemoteDesktopModifiers()
        modifiers.apply([true, false, true, false])
        XCTAssertEqual(modifiers.flags, [true, false, true, false])
        XCTAssertEqual(modifiers.selected, Set(["ControlLeft", "ShiftLeft"]))
        modifiers.apply([false, true, false, true])
        XCTAssertEqual(modifiers.flags, [false, true, false, true])
        XCTAssertEqual(modifiers.take(), ["AltLeft", "MetaLeft"])
        XCTAssertEqual(modifiers.flags, [false, false, false, false])
    }

    func testReducerAndFocusResetCancelSelectionWithoutSendingHeldKeys() {
        var modifiers = RemoteDesktopModifiers()
        modifiers.apply([false, true, false, false])
        modifiers.apply([false, false, false, false])
        XCTAssertTrue(modifiers.take().isEmpty)
        modifiers.apply([true, false, false, false])
        modifiers.reset()
        XCTAssertNil(modifiers.code(for: "c"))
    }

    func testSystemKeyboardShortcutsRequireOneAsciiCharacter() {
        var modifiers = RemoteDesktopModifiers()
        XCTAssertNil(modifiers.code(for: "c"))
        modifiers.apply([true, false, false, false])
        XCTAssertEqual(modifiers.code(for: "c"), "KeyC")
        XCTAssertEqual(modifiers.code(for: "C"), "KeyC")
        XCTAssertEqual(modifiers.code(for: "1"), "Digit1")
        XCTAssertEqual(modifiers.code(for: " "), "Space")
        XCTAssertEqual(modifiers.code(for: "/"), "Slash")
        XCTAssertEqual(modifiers.code(for: "["), "BracketLeft")
        for text in ["你好", "ß", "😀", "copy", "", "é"] {
            XCTAssertNil(modifiers.code(for: text), "IME commits must remain Unicode text: \(text)")
        }
    }
}
