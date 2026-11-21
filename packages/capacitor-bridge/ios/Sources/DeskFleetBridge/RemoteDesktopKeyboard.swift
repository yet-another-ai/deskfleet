import UIKit

/// UIKit owns marked text and candidate selection; only committed edits leave the device.
final class RemoteDesktopKeyboard: UITextView, UITextViewDelegate {
    private static let anchor = "\u{200B}"
    var sendText: ((String) -> Void)?
    var sendKey: ((String) -> Void)?
    var visibilityChanged: ((Bool) -> Void)?

    init() {
        super.init(frame: .zero, textContainer: nil)
        delegate = self
        autocorrectionType = .no
        autocapitalizationType = .none
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        spellCheckingType = .no
        textContentType = .none
        keyboardDismissMode = .none
        accessibilityLabel = "Remote desktop keyboard"
        alpha = 0.01
        reset()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func reset() {
        text = Self.anchor
        selectedRange = NSRange(location: 1, length: 0)
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
        // Marked-text edits stay local, including deleting a candidate syllable.
        guard markedTextRange == nil else { return true }
        if replacement == "\n" {
            sendKey?("Enter")
            return false
        }
        if replacement.isEmpty && text == Self.anchor {
            sendKey?("Backspace")
            return false
        }
        return true
    }

    func textViewDidChange(_ textView: UITextView) {
        guard markedTextRange == nil else { return }
        let committed = text.hasPrefix(Self.anchor) ? String(text.dropFirst()) : text ?? ""
        if !committed.isEmpty { sendText?(committed) }
        reset()
    }

    func textViewDidBeginEditing(_ textView: UITextView) { visibilityChanged?(true) }
    func textViewDidEndEditing(_ textView: UITextView) {
        reset()
        visibilityChanged?(false)
    }
}
