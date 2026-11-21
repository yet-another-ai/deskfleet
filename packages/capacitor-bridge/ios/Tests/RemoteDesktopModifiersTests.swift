import XCTest
@testable import DeskFleetLocalFiles

final class RemoteDesktopModifiersTests: XCTestCase {
    func testChordUsesStableOrderAndConsumesOneShotModifiers() {
        var modifiers = RemoteDesktopModifiers()
        modifiers.toggle("MetaLeft")
        modifiers.toggle("ShiftLeft")
        modifiers.toggle("ControlLeft")
        XCTAssertEqual(modifiers.take(), ["ControlLeft", "ShiftLeft", "MetaLeft"])
        XCTAssertTrue(modifiers.selected.isEmpty)
        XCTAssertTrue(modifiers.take().isEmpty)
    }

    func testToggleAndFocusResetCancelSelectionWithoutSendingHeldKeys() {
        var modifiers = RemoteDesktopModifiers()
        modifiers.toggle("AltLeft")
        modifiers.toggle("AltLeft")
        XCTAssertTrue(modifiers.take().isEmpty)
        modifiers.toggle("ControlLeft")
        modifiers.reset()
        XCTAssertNil(modifiers.code(for: "c"))
    }

    func testSystemKeyboardShortcutsRequireOneAsciiCharacter() {
        var modifiers = RemoteDesktopModifiers()
        XCTAssertNil(modifiers.code(for: "c"))
        modifiers.toggle("ControlLeft")
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
