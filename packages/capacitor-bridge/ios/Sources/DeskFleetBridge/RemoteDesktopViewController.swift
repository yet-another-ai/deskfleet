import QuartzCore
import UIKit

final class MetalVideoView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }

    private var surfaceAttached = false
    private var lastDrawableSize: CGSize = .zero
    var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        isOpaque = true
        isMultipleTouchEnabled = true
        metalLayer.pixelFormat = .bgra8Unorm_srgb
        metalLayer.framebufferOnly = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0 else { return }
        let scale = window?.screen.scale ?? UIScreen.main.scale
        contentScaleFactor = scale
        metalLayer.contentsScale = scale
        let width = UInt32(max((bounds.width * scale).rounded(), 1))
        let height = UInt32(max((bounds.height * scale).rounded(), 1))
        let size = CGSize(width: Int(width), height: Int(height))
        metalLayer.drawableSize = size

        if !surfaceAttached {
            surfaceAttached = true
            lastDrawableSize = size
            deskfleetIosSurfaceCreated(Unmanaged.passUnretained(metalLayer).toOpaque(), width, height)
        } else if lastDrawableSize != size {
            lastDrawableSize = size
            deskfleetIosSurfaceChanged(width, height)
        }
    }

    func detachSurface() {
        guard surfaceAttached else { return }
        surfaceAttached = false
        lastDrawableSize = .zero
        deskfleetIosSurfaceDestroyed()
    }
}

final class RemoteDesktopViewController: UIViewController {
    private static let maxClipboardBytes = 32 * 1024
    private let metalView = MetalVideoView(frame: .zero)
    private let controls = RemoteDesktopControls()
    private let keyboard = RemoteDesktopKeyboard()
    private let hackerKeyboard = RemoteDesktopHackerKeyboard()
    private var state: [String: Any] = [:]
    private var relative = false
    private var paused = false
    private var terminalPaste = false
    private var dragging = false
    private var dragLocked = false
    private var closeSent = false
    private var lastSyncedClipboard: String?
    private var lastPasteboardChangeCount: Int = UIPasteboard.general.changeCount

    private var inputEnabled: Bool {
        state["status"] as? String == "connected" && state["control"] as? Bool == true
            && state["inputReady"] as? Bool == true && !paused
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        metalView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(metalView)
        view.addSubview(keyboard)
        view.addSubview(hackerKeyboard)
        view.addSubview(controls)
        hackerKeyboard.isHidden = true
        keyboard.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        NSLayoutConstraint.activate([
            metalView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            metalView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            metalView.topAnchor.constraint(equalTo: view.topAnchor),
            metalView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        controls.action = { [weak self] action in self?.handleAction(action) }
        controls.selectDisplay = { [weak self] id in
            self?.releaseInput()
            self?.emit(["type": "selectDisplay", "displayId": id])
        }
        keyboard.sendText = { [weak self] text in
            guard let self, self.inputEnabled else { return }
            if !self.hackerKeyboard.consumeText(text) {
                self.releaseInput()
                let mac = self.state["platform"] as? String == "darwin"
                self.send(["type": "text", "text": text, "pasteCode": mac ? "MetaLeft" : "ControlLeft", "pasteShift": !mac && self.terminalPaste])
                self.updateControls()
            }
        }
        keyboard.sendKey = { [weak self] code in self?.hackerKeyboard.press(code) }
        keyboard.visibilityChanged = { [weak self] _ in
            self?.updateControls()
            self?.view.setNeedsLayout()
        }
        hackerKeyboard.sendKey = { [weak self] code, modifiers in self?.sendKey(code, modifiers: modifiers) }

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:)))
        metalView.addGestureRecognizer(tap)
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = 0.5
        metalView.addGestureRecognizer(longPress)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 2
        metalView.addGestureRecognizer(pan)

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(handleFocusLost), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(handleDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(handlePasteboardChanged), name: UIPasteboard.changedNotification, object: nil)
        center.addObserver(self, selector: #selector(handleKeyboardFrameChanged), name: UIResponder.keyboardDidChangeFrameNotification, object: nil)
        updateControls()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        var available = view.safeAreaLayoutGuide.layoutFrame.insetBy(dx: 8, dy: 8)
        // keyboardLayoutGuide follows docked keyboards, rotation, and split view.
        let keyboardTop = view.keyboardLayoutGuide.layoutFrame.minY
        available.size.height = max(52, min(available.maxY, keyboardTop - 8) - available.minY)
        if !hackerKeyboard.isHidden {
            let width = min(600, available.width)
            let height = min(252, max(44, available.height - 60))
            hackerKeyboard.frame = CGRect(x: available.midX - width / 2, y: available.maxY - height, width: width, height: height)
            available.size.height = max(52, available.height - height - 8)
        }
        controls.layout(in: available)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        handleFocusLost()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        metalView.detachSurface()
        if DeskFleetBridge.activeController === self { DeskFleetBridge.activeController = nil }
        if isBeingDismissed && !closeSent { closeSent = true; deskfleetIosTouch(7, 0, 0, 0, 0) }
    }

    func prepareForExternalStop() {
        closeSent = true
        releaseInput()
        keyboard.resignFirstResponder()
        metalView.detachSurface()
    }

    func applyViewerCommand(_ command: [String: Any]) {
        if command["type"] as? String == "ui", let next = command["state"] as? [String: Any] {
            let wasEnabled = inputEnabled
            let changedDisplay = state["displayId"] as? Int != next["displayId"] as? Int
            state = next
            switch next["theme"] as? String {
            case "dark": overrideUserInterfaceStyle = .dark
            case "light": overrideUserInterfaceStyle = .light
            default: overrideUserInterfaceStyle = .unspecified
            }
            if paused && next["status"] as? String != "connected" {
                paused = false
                // A transient reconnect may keep this peer, whose pause gate must also reset.
                send(["type": "pauseInput", "paused": false])
            }
            if wasEnabled && !inputEnabled || changedDisplay {
                releaseInput()
                keyboard.resignFirstResponder()
                hackerKeyboard.isHidden = true
            }
            if changedDisplay { deskfleetIosTouch(14, 0, 0, 0, 0) }
            updateControls()
        } else if ["stop", "close"].contains(command["type"] as? String ?? "") {
            releaseInput()
            keyboard.resignFirstResponder()
        }
    }

    private func updateControls() {
        controls.update(state: state, relative: relative, paused: paused, dragging: dragLocked,
                        keyboard: keyboard.isFirstResponder, hacker: !hackerKeyboard.isHidden, terminalPaste: terminalPaste)
        view.setNeedsLayout()
    }

    private func handleAction(_ action: String) {
        switch action {
        case "pointer":
            releaseInput()
            relative.toggle()
            deskfleetIosTouch(14, 0, 0, 0, 0)
        case "keyboard" where inputEnabled:
            if keyboard.isFirstResponder { keyboard.resignFirstResponder() }
            else { keyboard.becomeFirstResponder() }
        case "hacker" where inputEnabled:
            hackerKeyboard.resetModifiers()
            hackerKeyboard.isHidden.toggle()
        case "pause":
            releaseInput()
            paused.toggle()
            send(["type": "pauseInput", "paused": paused])
            if paused { keyboard.resignFirstResponder(); hackerKeyboard.isHidden = true }
        case "control":
            releaseInput()
            emit(["type": "setControl", "control": state["control"] as? Bool != true])
        case "drag" where inputEnabled:
            dragLocked.toggle()
            if relative { deskfleetIosTouch(dragLocked ? 11 : 12, 0, 0, 0, 0) }
            else if !dragLocked { releaseInput() }
        case "clipboard" where inputEnabled: syncLocalClipboardToRemote(force: true)
        case "terminalPaste": terminalPaste.toggle()
        case "secure" where inputEnabled: sendInput(["type": "secureAttention"])
        case "connection":
            releaseInput()
            emit(["type": state["status"] as? String == "connected" ? "disconnect" : "reconnect"])
        case "close": handleCloseTapped()
        default: break
        }
        updateControls()
    }

    private func releaseInput() {
        dragging = false
        dragLocked = false
        hackerKeyboard.resetModifiers()
        sendInput(["type": "releaseAll"])
        deskfleetIosTouch(6, 0, 0, 0, 0)
    }

    @objc private func handleFocusLost() {
        releaseInput()
        keyboard.resignFirstResponder()
        updateControls()
    }

    @objc private func handleKeyboardFrameChanged() { view.setNeedsLayout() }

    private func send(_ command: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: command),
              let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { deskfleetIosSendCommand($0) }
    }

    private func sendInput(_ event: [String: Any]) { send(["type": "input", "event": event]) }

    private func emit(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else { return }
        DeskFleetBridge.activePlugin?.notifyListeners("viewerEvent", data: ["payload": json])
    }

    private func sendKey(_ code: String, modifiers: [String]) {
        guard inputEnabled else { return }
        for key in modifiers + [code] { sendInput(["type": "key", "code": key, "pressed": true, "repeat": false]) }
        for key in ([code] + modifiers.reversed()) { sendInput(["type": "key", "code": key, "pressed": false, "repeat": false]) }
    }

    private func scaledPoint(_ recognizer: UIGestureRecognizer) -> (Double, Double) {
        let point = recognizer.location(in: metalView)
        let scale = metalView.contentScaleFactor
        return (Double(point.x * scale), Double(point.y * scale))
    }

    @objc private func handleSingleTap(_ recognizer: UITapGestureRecognizer) {
        guard inputEnabled, recognizer.state == .ended else { return }
        let (x, y) = scaledPoint(recognizer)
        if dragLocked { releaseInput(); updateControls() }
        else { deskfleetIosTouch(relative ? 9 : 3, x, y, 0, 0) }
    }

    @objc private func handleLongPress(_ recognizer: UILongPressGestureRecognizer) {
        guard inputEnabled, recognizer.state == .began else { return }
        let (x, y) = scaledPoint(recognizer)
        deskfleetIosTouch(relative ? 10 : 4, x, y, 0, 0)
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        guard inputEnabled else { return }
        let (x, y) = scaledPoint(recognizer)
        let scale = metalView.contentScaleFactor
        let translation = recognizer.translation(in: metalView)
        recognizer.setTranslation(.zero, in: metalView)
        switch recognizer.state {
        case .began, .changed:
            if recognizer.numberOfTouches >= 2 {
                if dragging || dragLocked { releaseInput(); updateControls() }
                deskfleetIosTouch(relative ? 13 : 5, x, y, Double(-translation.x * scale), Double(-translation.y * scale))
            } else if relative {
                deskfleetIosTouch(8, 0, 0, Double(translation.x * scale), Double(translation.y * scale))
            } else {
                if !dragging { dragging = true; deskfleetIosTouch(1, x, y, 0, 0) }
                deskfleetIosTouch(0, x, y, 0, 0)
            }
        case .cancelled, .failed:
            releaseInput()
            updateControls()
        case .ended:
            if dragging && !dragLocked {
                dragging = false
                deskfleetIosTouch(relative ? 12 : 2, x, y, 0, 0)
            }
        default: break
        }
    }

    private func handleCloseTapped() {
        releaseInput()
        keyboard.resignFirstResponder()
        if !closeSent { closeSent = true; deskfleetIosTouch(7, 0, 0, 0, 0) }
        metalView.detachSurface()
        dismiss(animated: false)
    }

    @objc private func handleDidBecomeActive() { syncLocalClipboardToRemote(force: false) }
    @objc private func handlePasteboardChanged() { syncLocalClipboardToRemote(force: false) }

    func applyRemoteClipboard(_ rawText: String) {
        let sanitized = rawText.replacingOccurrences(of: "\0", with: "")
        guard !sanitized.isEmpty, sanitized.utf8.count <= Self.maxClipboardBytes,
              sanitized != lastSyncedClipboard else { return }
        lastSyncedClipboard = sanitized
        UIPasteboard.general.string = sanitized
        lastPasteboardChangeCount = UIPasteboard.general.changeCount
    }

    private func syncLocalClipboardToRemote(force: Bool) {
        guard inputEnabled else { return }
        let pasteboard = UIPasteboard.general
        let currentCount = pasteboard.changeCount
        if !force && currentCount == lastPasteboardChangeCount { return }
        lastPasteboardChangeCount = currentCount
        guard pasteboard.hasStrings, let rawText = pasteboard.string else { return }
        let sanitized = rawText.replacingOccurrences(of: "\0", with: "")
        guard !sanitized.isEmpty, sanitized.utf8.count <= Self.maxClipboardBytes,
              sanitized != lastSyncedClipboard else { return }
        lastSyncedClipboard = sanitized
        send(["type": "clipboard", "text": sanitized])
    }
}
