import UIKit

final class RemoteDesktopControls: UIView {
    var action: ((String) -> Void)?
    var selectDisplay: ((Int) -> Void)?
    private let stack = UIStackView()
    private let menuScroll = UIScrollView()
    private let menu = UIStackView()
    private let status = UILabel()
    private var buttons: [String: UIButton] = [:]
    private var expanded = false
    private var origin: CGPoint?
    private var dragOrigin = CGPoint.zero
    private var boundsToUse = CGRect.zero
    private var menuHeight: NSLayoutConstraint!
    private var terminalPasteRow: UIStackView?
    private var chinese = false

    init() {
        super.init(frame: .zero)
        backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.96)
        layer.cornerRadius = 14
        layer.borderWidth = 1
        layer.borderColor = UIColor.separator.cgColor
        layer.shadowOpacity = 0.2
        layer.shadowRadius = 8
        accessibilityLabel = "Remote desktop controls"
        stack.axis = .vertical
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4)
        ])

        let bar = UIStackView()
        bar.distribution = .fillEqually
        bar.spacing = 2
        let grip = UIButton(type: .system)
        grip.setTitle("⠿", for: .normal)
        grip.accessibilityLabel = "Move controls"
        grip.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag(_:))))
        bar.addArrangedSubview(grip)
        for (name, title) in [("pointer", "☝"), ("keyboard", "⌨"), ("hacker", "{ }"), ("menu", "•••")] {
            bar.addArrangedSubview(makeButton(name, title))
        }
        bar.heightAnchor.constraint(equalToConstant: 44).isActive = true
        stack.addArrangedSubview(bar)

        menu.axis = .vertical
        menu.spacing = 4
        menu.translatesAutoresizingMaskIntoConstraints = false
        menuScroll.addSubview(menu)
        NSLayoutConstraint.activate([
            menu.leadingAnchor.constraint(equalTo: menuScroll.contentLayoutGuide.leadingAnchor),
            menu.trailingAnchor.constraint(equalTo: menuScroll.contentLayoutGuide.trailingAnchor),
            menu.topAnchor.constraint(equalTo: menuScroll.contentLayoutGuide.topAnchor),
            menu.bottomAnchor.constraint(equalTo: menuScroll.contentLayoutGuide.bottomAnchor),
            menu.widthAnchor.constraint(equalTo: menuScroll.frameLayoutGuide.widthAnchor)
        ])
        status.font = .preferredFont(forTextStyle: .caption1)
        status.numberOfLines = 0
        status.textAlignment = .center
        menu.addArrangedSubview(status)
        addRow([("display", "Display"), ("control", "Control")])
        addRow([("pause", "Pause"), ("drag", "Drag")])
        addRow([("clipboard", "Clipboard"), ("secure", "Ctrl+Alt+Del")])
        terminalPasteRow = addRow([("terminalPaste", "Terminal paste (Ctrl+Shift+V)")])
        addRow([("connection", "Disconnect"), ("close", "Close")])
        menuHeight = menuScroll.heightAnchor.constraint(equalToConstant: 212)
        menuHeight.isActive = true
        menuScroll.isHidden = true
        stack.addArrangedSubview(menuScroll)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    @discardableResult
    private func addRow(_ entries: [(String, String)]) -> UIStackView {
        let row = UIStackView()
        row.spacing = 4
        row.distribution = .fillEqually
        for (name, title) in entries { row.addArrangedSubview(makeButton(name, title)) }
        row.heightAnchor.constraint(equalToConstant: 44).isActive = true
        menu.addArrangedSubview(row)
        return row
    }

    private func makeButton(_ name: String, _ title: String) -> UIButton {
        let button = UIButton(type: .system)
        var configuration = UIButton.Configuration.tinted()
        configuration.title = title
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 4, bottom: 8, trailing: 4)
        button.configuration = configuration
        button.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            if name == "menu" {
                self.expanded.toggle()
                self.menuScroll.isHidden = !self.expanded
                self.layout(in: self.boundsToUse)
            } else {
                self.action?(name)
            }
        }, for: .touchUpInside)
        buttons[name] = button
        return button
    }

    func update(state: [String: Any], relative: Bool, paused: Bool, dragging: Bool, keyboard: Bool, hacker: Bool, terminalPaste: Bool) {
        chinese = (state["locale"] as? String)?.hasPrefix("zh") == true
        let connected = state["status"] as? String == "connected"
        let control = state["control"] as? Bool == true
        let ready = connected && control && state["inputReady"] as? Bool == true
        let enabled = ready && !paused
        set("pointer", title: relative ? label("Rel", "相对") : label("Abs", "绝对"), label: relative ? label("Relative mouse", "相对鼠标") : label("Absolute mouse", "绝对鼠标"))
        set("keyboard", title: "⌨", label: label("System keyboard", "系统键盘"), selected: keyboard, enabled: enabled)
        set("hacker", title: "{ }", label: "Hacker Keyboard", selected: hacker, enabled: enabled)
        set("menu", title: "•••", label: label("More controls", "更多控制"))
        set("control", title: label("Control", "鼠标和键盘"), selected: control, enabled: connected)
        set("pause", title: paused ? label("Resume", "恢复控制") : label("Pause", "暂停控制"), selected: paused, enabled: ready)
        set("drag", title: label("Drag", "拖动"), selected: dragging, enabled: enabled)
        set("clipboard", title: label("Clipboard", "同步剪贴板"), enabled: enabled)
        set("secure", title: "Ctrl+Alt+Del", enabled: enabled && state["secureAttention"] as? Bool == true)
        set("terminalPaste", title: label("Terminal paste (Ctrl+Shift+V)", "终端粘贴（Ctrl+Shift+V）"), selected: terminalPaste)
        terminalPasteRow?.isHidden = state["platform"] as? String == "darwin"
        set("connection", title: connected ? label("Disconnect", "断开连接") : label("Reconnect", "重新连接"))
        set("close", title: label("Close", "关闭"))
        status.text = state["settingsError"] as? String ?? state["error"] as? String ?? (paused ? label("Control paused", "已暂停控制") : (connected ? label("Connected", "已连接") : label("Not connected", "未连接")))
        updateDisplays(state)
    }

    private func updateDisplays(_ state: [String: Any]) {
        let displays = state["displays"] as? [[String: Any]] ?? []
        let selected = state["displayId"] as? Int
        let actions = displays.compactMap { display -> UIAction? in
            guard let id = display["id"] as? Int else { return nil }
            let title = display["name"] as? String ?? "\(label("Display", "显示器")) \(display["displayNumber"] as? Int ?? id)"
            return UIAction(title: title, state: id == selected ? .on : .off) { [weak self] _ in self?.selectDisplay?(id) }
        }
        buttons["display"]?.menu = UIMenu(children: actions)
        buttons["display"]?.showsMenuAsPrimaryAction = true
        set("display", title: label("Display", "显示器"), enabled: !actions.isEmpty)
    }

    private func label(_ english: String, _ chineseText: String) -> String { chinese ? chineseText : english }

    private func set(_ name: String, title: String, label: String? = nil, selected: Bool = false, enabled: Bool = true) {
        let button = buttons[name]
        button?.configuration?.title = title
        button?.accessibilityLabel = label ?? title
        button?.isSelected = selected
        button?.isEnabled = enabled
    }

    func layout(in available: CGRect) {
        boundsToUse = available
        guard available.width > 0, available.height > 0 else { return }
        let width = min(320, available.width)
        menuHeight.constant = min(212, max(0, available.height - 56))
        let height: CGFloat = expanded ? 56 + menuHeight.constant : 52
        let proposed = origin ?? CGPoint(x: available.maxX - width, y: available.minY)
        let point = CGPoint(
            x: min(max(proposed.x, available.minX), available.maxX - width),
            y: min(max(proposed.y, available.minY), max(available.minY, available.maxY - height))
        )
        frame = CGRect(origin: point, size: CGSize(width: width, height: height))
        if origin != nil { origin = point }
    }

    @objc private func drag(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began { dragOrigin = frame.origin }
        let delta = gesture.translation(in: superview)
        origin = CGPoint(x: dragOrigin.x + delta.x, y: dragOrigin.y + delta.y)
        layout(in: boundsToUse)
    }
}
