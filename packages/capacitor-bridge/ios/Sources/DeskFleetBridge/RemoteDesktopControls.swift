import UIKit

@_silgen_name("deskfleet_ios_controls_create")
private func createControls(_ identity: UInt64, _ callback: @convention(c) (UInt64, UnsafePointer<CChar>?) -> Void) -> UnsafeMutableRawPointer?
@_silgen_name("deskfleet_ios_controls_view")
private func controlsView(_ handle: UnsafeMutableRawPointer) -> UnsafeMutableRawPointer?
@_silgen_name("deskfleet_ios_controls_update")
private func updateControls(_ handle: UnsafeMutableRawPointer, _ json: UnsafePointer<CChar>)
@_silgen_name("deskfleet_ios_controls_destroy")
private func destroyControls(_ handle: UnsafeMutableRawPointer)

private final class WeakControls {
    weak var value: RemoteDesktopControls?
    init(_ value: RemoteDesktopControls) { self.value = value }
}

private let controlsCallback: @convention(c) (UInt64, UnsafePointer<CChar>?) -> Void = { identity, pointer in
    guard let pointer else { return }
    // NSH owns this buffer only during the callback; copy before crossing threads.
    let json = String(cString: pointer)
    DispatchQueue.main.async {
        guard let data = json.data(using: .utf8),
              let action = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        RemoteDesktopControls.instances[identity]?.value?.receive(action)
    }
}

/// Owns the shared Rust UI's UIView and the platform geometry/touch boundary.
final class RemoteDesktopControls: UIView, UIGestureRecognizerDelegate {
    fileprivate static var instances: [UInt64: WeakControls] = [:]
    private let identity = UInt64.random(in: 1...UInt64.max)
    private var handle: UnsafeMutableRawPointer?
    private var hostedView: UIView?
    var action: (([String: Any]) -> Void)?
    private var snapshot: [String: Any] = [:]
    private var position = CGPoint(x: 12, y: 12)
    private var toolbarSize = CGSize(width: 320, height: 100)
    private var panelHeight: CGFloat = 320
    private var keyboardHeight: CGFloat = 260
    private var toolbarRect = CGRect.zero
    private var panelRect = CGRect.zero
    private var keyboardRect = CGRect.zero
    /// The open toolbar dropdown: "control", "config", or "monitor".
    private var panel: String?
    private var selectOpen = false
    private var collapsed = false
    private var dragOrigin = CGPoint.zero
    private var connected = false

    init() {
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        Self.instances[identity] = WeakControls(self)
        handle = createControls(identity, controlsCallback)
        if let handle, let pointer = controlsView(handle) {
            let hosted = Unmanaged<UIView>.fromOpaque(pointer).takeUnretainedValue()
            hosted.backgroundColor = .clear
            hosted.isOpaque = false
            addSubview(hosted)
            hostedView = hosted
        }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
        pan.delegate = self
        addGestureRecognizer(pan)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        Self.instances.removeValue(forKey: identity)
        hostedView?.removeFromSuperview()
        if let handle { destroyControls(handle) }
    }

    func stop() {
        Self.instances.removeValue(forKey: identity)
        hostedView?.removeFromSuperview()
        hostedView = nil
        if let handle { destroyControls(handle); self.handle = nil }
    }

    func update(state: [String: Any], relative: Bool, paused: Bool, dragging: Bool,
                keyboard: Bool, hacker: Bool, terminalPaste: Bool, modifiers: Set<String>,
                reverseScroll: Bool, clipboardSharing: Bool, fullscreen: Bool, pinchZoom: Bool) {
        var ui: [String: Any] = ["status": "starting", "title": "", "displays": [], "displayId": 0,
                                 "control": false, "inputReady": false, "secureAttention": false]
        ui.merge(state) { _, next in next }
        connected = ui["status"] as? String == "connected"
        if !connected {
            panel = nil
            selectOpen = false
        }
        snapshot = ["ui": ui, "mobile": true, "relativeMouse": relative, "paused": paused,
                    "dragging": dragging, "fullscreen": fullscreen, "keyboardOpen": keyboard, "hackerOpen": hacker,
                    "pasteShift": terminalPaste, "reverseScroll": reverseScroll, "clipboardSharing": clipboardSharing, "pinchZoom": pinchZoom,
                    "modifiers": ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"].map { modifiers.contains($0) }]
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        hostedView?.frame = bounds
        publish()
    }

    private func publish() {
        guard let handle, bounds.width > 0, bounds.height > 0 else { return }
        let hacker = snapshot["hackerOpen"] as? Bool == true
        let keyboardWidth = min(520, max(0, bounds.width - 24))
        let maximumKeyboardHeight = min(400, max(40, bounds.height - toolbarSize.height - 32))
        let height = min(keyboardHeight, maximumKeyboardHeight)
        keyboardRect = hacker ? CGRect(x: (bounds.width - keyboardWidth) / 2,
                                      y: max(0, bounds.height - height - 12), width: keyboardWidth, height: height) : .zero
        let availableHeight = hacker ? keyboardRect.minY - 8 : bounds.height
        position.x = min(max(12, position.x), max(12, bounds.width - toolbarSize.width - 12))
        position.y = min(max(12, position.y), max(12, availableHeight - toolbarSize.height - 12))
        toolbarRect = CGRect(origin: position, size: toolbarSize)
        let panelWidth = min(288, max(0, bounds.width - 24))
        let panelY = min(toolbarRect.maxY + 8, max(12, availableHeight - panelHeight - 12))
        panelRect = panel != nil ? CGRect(x: min(position.x, max(12, bounds.width - panelWidth - 12)),
                                         y: panelY, width: panelWidth, height: panelHeight) : .zero
        snapshot.merge([
            "collapsed": collapsed, "dark": traitCollection.userInterfaceStyle == .dark, "panel": panel ?? NSNull(),
            "position": [position.x, position.y], "toolbarSize": [toolbarSize.width, toolbarSize.height],
            "viewport": [bounds.width, bounds.height], "panelPosition": [panelRect.minX, panelRect.minY],
            "panelHeight": panelHeight, "keyboardPosition": [keyboardRect.minX, keyboardRect.minY],
            "keyboardSize": [keyboardWidth, maximumKeyboardHeight]
        ]) { _, next in next }
        guard let data = try? JSONSerialization.data(withJSONObject: snapshot),
              let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { updateControls(handle, $0) }
    }

    fileprivate func receive(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "measured":
            guard let size = event["value"] as? [Double], size.count == 2 else { return }
            let next = CGSize(width: size[0], height: size[1])
            guard abs(next.width - toolbarSize.width) > 0.5 || abs(next.height - toolbarSize.height) > 0.5 else { return }
            toolbarSize = next
        case "panelMeasured":
            guard let height = event["value"] as? Double, abs(height - panelHeight) > 0.5 else { return }
            panelHeight = height
        case "toggleCollapsed":
            collapsed.toggle()
            panel = nil
            selectOpen = false
            action?(event)
        case "togglePanel":
            let next = event["value"] as? String
            panel = panel == next ? nil : next
            selectOpen = false
            action?(event)
        case "toggleHackerKeyboard", "reconnect", "disconnect":
            panel = nil
            selectOpen = false
            action?(event)
        case "selectOpen":
            selectOpen = event["value"] as? Bool == true
            action?(event)
        case "keyboardMeasured":
            guard let size = event["value"] as? [Double], size.count == 2,
                  abs(size[1] - keyboardHeight) > 0.5 else { return }
            keyboardHeight = size[1]
        default: action?(event)
        }
        setNeedsLayout()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // The NSH root fills the surface. Only visible controls consume touches;
        // all other points reach the Metal sibling and its remote-input gestures.
        guard !connected || selectOpen || toolbarRect.contains(point)
                || panelRect.contains(point) || keyboardRect.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        let grip = CGRect(x: toolbarRect.minX, y: toolbarRect.minY, width: 48, height: 48)
        return grip.contains(touch.location(in: self)) && !selectOpen
    }

    @objc private func drag(_ pan: UIPanGestureRecognizer) {
        if pan.state == .began {
            dragOrigin = position
            action?(["type": "focusHandle"])
        }
        if pan.state == .began || pan.state == .changed {
            let delta = pan.translation(in: self)
            position = CGPoint(x: dragOrigin.x + delta.x, y: dragOrigin.y + delta.y)
            publish()
        }
    }
}
