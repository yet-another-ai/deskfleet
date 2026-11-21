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

/// Modifiers are one-shot: choosing a key sends a complete chord, never a held key.
final class RemoteDesktopHackerKeyboard: UIView {
    var sendKey: ((String, [String]) -> Void)?
    private let rows = UIStackView()
    private var modifiers = RemoteDesktopModifiers()
    private var modifierButtons: [String: UIButton] = [:]

    init() {
        super.init(frame: .zero)
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        rows.axis = .vertical
        rows.spacing = 4
        rows.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        scroll.addSubview(rows)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            scroll.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            rows.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            rows.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            rows.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            rows.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            rows.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)
        ])
        backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.97)
        layer.cornerRadius = 14
        accessibilityLabel = "Hacker Keyboard"

        addRow([("Esc", "Escape"), ("Tab", "Tab"), ("Ctrl", "ControlLeft"), ("Alt", "AltLeft"), ("Shift", "ShiftLeft"), ("⌘/Win", "MetaLeft")], modifiers: true)
        addRow([("←", "ArrowLeft"), ("↑", "ArrowUp"), ("↓", "ArrowDown"), ("→", "ArrowRight"), ("⌫", "Backspace"), ("↵", "Enter")])
        addRow([("Home", "Home"), ("End", "End"), ("PgUp", "PageUp"), ("PgDn", "PageDown"), ("Ins", "Insert"), ("Del", "Delete")])
        addRow((1...12).map { ("F\($0)", "F\($0)") }, scrolling: true)
        addRow([("A", "KeyA"), ("C", "KeyC"), ("V", "KeyV"), ("X", "KeyX"), ("Z", "KeyZ"), ("Space", "Space")])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func resetModifiers() {
        modifiers.reset()
        for button in modifierButtons.values { button.isSelected = false }
    }

    func press(_ code: String) {
        sendKey?(code, modifiers.take())
        resetModifiers()
    }

    func consumeText(_ text: String) -> Bool {
        guard let code = modifiers.code(for: text) else { return false }
        press(code)
        return true
    }

    private func addRow(_ keys: [(String, String)], modifiers: Bool = false, scrolling: Bool = false) {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 4
        row.distribution = .fillEqually
        for (title, code) in keys {
            let button = UIButton(type: .system)
            var configuration = UIButton.Configuration.tinted()
            configuration.title = title
            configuration.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 2, bottom: 8, trailing: 2)
            button.configuration = configuration
            button.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
            button.accessibilityLabel = code
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
            if scrolling { button.widthAnchor.constraint(equalToConstant: 46).isActive = true }
            let isModifier = modifiers && code.hasSuffix("Left")
            if isModifier { modifierButtons[code] = button }
            button.addAction(UIAction { [weak self, weak button] _ in
                guard let self else { return }
                if isModifier {
                    self.modifiers.toggle(code)
                    button?.isSelected = self.modifiers.selected.contains(code)
                } else {
                    self.press(code)
                }
            }, for: .touchUpInside)
            row.addArrangedSubview(button)
        }
        if scrolling {
            let scroll = UIScrollView()
            scroll.showsHorizontalScrollIndicator = true
            row.translatesAutoresizingMaskIntoConstraints = false
            scroll.addSubview(row)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
                row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
                row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
                row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
                row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
                scroll.heightAnchor.constraint(equalToConstant: 44)
            ])
            rows.addArrangedSubview(scroll)
        } else {
            rows.addArrangedSubview(row)
        }
    }
}
