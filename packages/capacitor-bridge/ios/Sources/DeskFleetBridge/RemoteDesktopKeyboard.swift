import UIKit

@_silgen_name("deskfleet_ios_video_reset_keys")
func resetHardwareKeys(_ view: UnsafeMutableRawPointer)

@_silgen_name("deskfleet_ios_ime_presses")
private func routePresses(_ view: UnsafeMutableRawPointer, _ presses: UnsafeRawPointer,
                          _ pressed: Bool, _ composing: Bool) -> UnsafeRawPointer

/// UIKit owns marked text and candidate selection; only committed edits leave the device.
final class RemoteDesktopKeyboard: UITextView, UITextViewDelegate {
    private static let anchor = "\u{200B}"
    weak var video: UIView?
    var canForwardShortcut: (() -> Bool)?
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

    private func unhandled(_ presses: Set<UIPress>, pressed: Bool) -> Set<UIPress> {
        guard let video, canForwardShortcut?() == true else { return presses }
        let set = presses as NSSet
        let result = withExtendedLifetime(set) {
            routePresses(Unmanaged.passUnretained(video).toOpaque(),
                         Unmanaged.passUnretained(set).toOpaque(), pressed, markedTextRange != nil)
        }
        return Unmanaged<NSSet>.fromOpaque(result).takeRetainedValue() as! Set<UIPress>
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = unhandled(presses, pressed: true)
        if !rest.isEmpty { super.pressesBegan(rest, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = unhandled(presses, pressed: false)
        if !rest.isEmpty { super.pressesEnded(rest, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = unhandled(presses, pressed: false)
        if !rest.isEmpty { super.pressesCancelled(rest, with: event) }
    }

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
        if let video { resetHardwareKeys(Unmanaged.passUnretained(video).toOpaque()) }
        reset()
        visibilityChanged?(false)
    }
}
