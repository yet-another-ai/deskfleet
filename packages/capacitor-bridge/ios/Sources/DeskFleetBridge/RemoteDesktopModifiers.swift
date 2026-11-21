import Foundation

/// Selection is local until a complete, ordered key chord can be sent.
struct RemoteDesktopModifiers {
    private(set) var selected = Set<String>()
    private static let order = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"]

    mutating func toggle(_ code: String) {
        if !selected.insert(code).inserted { selected.remove(code) }
    }

    mutating func take() -> [String] {
        defer { selected.removeAll() }
        return Self.order.filter { selected.contains($0) }
    }

    mutating func reset() { selected.removeAll() }

    func code(for text: String) -> String? {
        guard !selected.isEmpty, text.unicodeScalars.count == 1,
              let scalar = text.unicodeScalars.first else { return nil }
        switch scalar.value {
        case 65...90: return "Key\(Character(scalar))"
        case 97...122: return "Key\(text.uppercased())"
        case 48...57: return "Digit\(Character(scalar))"
        case 32: return "Space"
        default:
            return [
                "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
                "\\": "Backslash", ";": "Semicolon", "'": "Quote", "`": "Backquote",
                ",": "Comma", ".": "Period", "/": "Slash"
            ][text]
        }
    }
}
