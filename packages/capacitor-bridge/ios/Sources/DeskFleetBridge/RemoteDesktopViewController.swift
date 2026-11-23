import UIKit

@_silgen_name("deskfleet_ios_mount_window")
private func mountWindow(_ root: UnsafeMutableRawPointer, _ keyboard: UnsafeMutableRawPointer,
                         _ controls: UnsafeMutableRawPointer) -> UnsafeMutableRawPointer
@_silgen_name("deskfleet_ios_send_key_chord")
private func sendKeyChord(_ video: UnsafeMutableRawPointer, _ codes: UnsafeRawPointer)
@_silgen_name("deskfleet_ios_video_stop")
private func stopVideo(_ video: UnsafeMutableRawPointer)
@_silgen_name("deskfleet_ios_video_configure_clipboard")
private func configureClipboard(_ video: UnsafeMutableRawPointer, _ enabled: Bool, _ sharing: Bool)
@_silgen_name("deskfleet_ios_video_reset_session")
private func resetVideoSession(_ video: UnsafeMutableRawPointer)
@_silgen_name("deskfleet_ios_video_sync_clipboard")
private func syncClipboard(_ video: UnsafeMutableRawPointer)

@_silgen_name("deskfleet_ios_pointer_install")
private func installPointer(_ video: UnsafeMutableRawPointer) -> UnsafeMutableRawPointer?
@_silgen_name("deskfleet_ios_pointer_configure")
private func configurePointer(_ pointer: UnsafeMutableRawPointer, _ enabled: Bool, _ reverseScroll: Bool)

final class RemoteDesktopViewController: UIViewController, UIGestureRecognizerDelegate {
    private var metalView: UIView!
    private let controls = RemoteDesktopControls()
    private let keyboard = RemoteDesktopKeyboard()
    private var modifiers = RemoteDesktopModifiers()
    private var hackerOpen = false
    private var inputState = RemoteDesktopInputState()
    private var reverseScroll = false
    private var clipboardSharing = true
    private var pinchZoom = true
    private var pinching = false
    /// Set once a gesture pinches; its remaining pan never scrolls or drags the remote.
    private var panSuppressed = false
    private let pan = UIPanGestureRecognizer()
    private var pointer: UnsafeMutableRawPointer? // Borrowed from the video view.
    private var fullscreen = true
    private var state: [String: Any] = [:]
    private var relative = false
    private var paused = false
    private var terminalPaste = false
    private var dragging = false
    private var dragLocked = false
    private var viewerVisible = false
    private var closeSent = false
    private var stopped = false

    private var connected: Bool { state["status"] as? String == "connected" }

    private var inputEnabled: Bool {
        connected && state["control"] as? Bool == true
            && state["inputReady"] as? Bool == true && !paused
    }

    override var prefersStatusBarHidden: Bool { fullscreen }
    override var prefersHomeIndicatorAutoHidden: Bool { fullscreen }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        resetSession()
        let video = mountWindow(Unmanaged.passUnretained(view!).toOpaque(),
                                Unmanaged.passUnretained(keyboard).toOpaque(),
                                Unmanaged.passUnretained(controls).toOpaque())
        metalView = Unmanaged<UIView>.fromOpaque(video).takeUnretainedValue()
        keyboard.video = metalView
        keyboard.canForwardShortcut = { [weak self] in self?.inputEnabled == true }
        controls.action = { [weak self] action in self?.handleAction(action) }
        keyboard.sendText = { [weak self] text in
            guard let self, self.inputEnabled else { return }
            if let code = self.modifiers.code(for: text) {
                self.pressKey(code)
            } else {
                self.releaseInput(forTyping: true)
                let mac = self.state["platform"] as? String == "darwin"
                self.send(["type": "text", "text": text, "pasteCode": mac ? "MetaLeft" : "ControlLeft", "pasteShift": !mac && self.terminalPaste])
                self.updateControls()
            }
        }
        keyboard.sendKey = { [weak self] code in self?.pressKey(code) }
        keyboard.visibilityChanged = { [weak self] _ in
            // UIKit must finish changing the text responder before restoring hardware focus.
            DispatchQueue.main.async { [weak self] in self?.updateControls() }
        }

        pointer = installPointer(Unmanaged.passUnretained(metalView).toOpaque())
        let directTouches = [UITouch.TouchType.direct, .pencil].map { NSNumber(value: $0.rawValue) }
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:)))
        tap.allowedTouchTypes = directTouches
        metalView.addGestureRecognizer(tap)
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.allowedTouchTypes = directTouches
        longPress.minimumPressDuration = 0.5
        metalView.addGestureRecognizer(longPress)
        pan.allowedTouchTypes = directTouches
        pan.addTarget(self, action: #selector(handlePan(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 2
        metalView.addGestureRecognizer(pan)
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        pinch.allowedTouchTypes = directTouches
        pinch.delegate = self
        metalView.addGestureRecognizer(pinch)

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(handleFocusLost), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(handleDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(windowFocusChanged(_:)), name: UIWindow.didResignKeyNotification, object: nil)
        center.addObserver(self, selector: #selector(windowFocusChanged(_:)), name: UIWindow.didBecomeKeyNotification, object: nil)
        updateControls()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        viewerVisible = true
        updateHardwareFocus()
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        viewerVisible = false
        UIApplication.shared.isIdleTimerDisabled = false
        if isBeingDismissed && !closeSent {
            state["inputReady"] = false
            resetSession()
        }
        if !closeSent { handleFocusLost() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed && !closeSent { closeSent = true; sendTouch(7, 0, 0, 0, 0) }
        detachWindow()
        if DeskFleetBridge.activeController === self { DeskFleetBridge.activeController = nil }
    }

    private func detachWindow() {
        guard !stopped else { return }
        stopped = true
        NotificationCenter.default.removeObserver(self)
        if let metalView { stopVideo(Unmanaged.passUnretained(metalView).toOpaque()) }
        pointer = nil
        keyboard.video = nil
        controls.stop()
    }

    func prepareForExternalStop() {
        guard !closeSent else { return }
        viewerVisible = false
        closeSent = true
        state["inputReady"] = false
        resetSession()
        releaseInput()
        keyboard.resignFirstResponder()
        updateHardwareFocus()
        detachWindow()
    }

    func applyViewerCommand(_ command: [String: Any]) {
        precondition(Thread.isMainThread)
        if command["type"] as? String == "ui", let next = command["state"] as? [String: Any] {
            let wasEnabled = inputEnabled
            let wasConnected = connected
            let changedDisplay = state["displayId"] as? Int != next["displayId"] as? Int
            state = next
            if wasConnected && !connected { resetSession() }
            switch next["theme"] as? String {
            case "dark": overrideUserInterfaceStyle = .dark
            case "light": overrideUserInterfaceStyle = .light
            default: overrideUserInterfaceStyle = .unspecified
            }
            handleAction(["type": "sessionChanged", "value": ["wasEnabled": wasEnabled,
                                                               "displayChanged": changedDisplay]])
        } else if command["type"] as? String == "start" {
            resetSession()
        } else if ["stop", "close"].contains(command["type"] as? String ?? "") {
            state["inputReady"] = false
            resetSession()
            updateHardwareFocus()
            releaseInput()
            keyboard.resignFirstResponder()
            updateControls()
        }
    }

    private func updateHardwareFocus() {
        guard !stopped, let metalView else { return }
        let activeInput = viewerVisible && inputEnabled && view.window?.isKeyWindow == true
            && view.window?.windowScene?.activationState == .foregroundActive
        if let pointer { configurePointer(pointer, activeInput, reverseScroll) }
        let capture = activeInput && !keyboard.isFirstResponder && !controls.ownsKeyboardFocus
        if capture && !metalView.isFirstResponder { metalView.becomeFirstResponder() }
        if !capture && metalView.isFirstResponder { metalView.resignFirstResponder() }
    }

    private var controlState: RemoteDesktopControlState {
        RemoteDesktopControlState(ui: state, relativeMouse: relative, paused: paused, dragging: dragLocked,
                                  keyboardOpen: keyboard.isFirstResponder, hackerOpen: hackerOpen,
                                  pasteShift: terminalPaste, modifiers: modifiers, reverseScroll: reverseScroll,
                                  clipboardSharing: clipboardSharing, fullscreen: fullscreen, pinchZoom: pinchZoom)
    }

    private func updateControls() {
        if !stopped, let metalView {
            configureClipboard(Unmanaged.passUnretained(metalView).toOpaque(), inputEnabled, clipboardSharing)
        }
        updateHardwareFocus()
        controls.update(state: controlState)
        viewIfLoaded?.setNeedsLayout()
    }

    private func handleAction(_ action: [String: Any]) {
        precondition(Thread.isMainThread)
        for effect in controls.effects(for: action, state: controlState) {
            switch effect["type"] as? String {
            case "release":
                releaseInput(preserveSelectedModifiers: effect["value"] as? Bool == true)
            case "paused":
                paused = effect["value"] as? Bool == true
                send(["type": "pauseInput", "paused": paused])
            case "relativeMouse": relative = effect["value"] as? Bool == true
            case "dragButton":
                dragLocked = effect["value"] as? Bool == true
                sendTouch(dragLocked ? 11 : 12, 0, 0, 0, 0)
            case "resetPointer": sendTouch(14, 0, 0, 0, 0)
            case "hackerOpen": hackerOpen = effect["value"] as? Bool == true
            case "modifiers":
                if let flags = effect["value"] as? [Bool] { modifiers.apply(flags) }
            case "chord":
                guard let codes = effect["value"] as? [String], !codes.isEmpty else { continue }
                releaseInput(forTyping: true)
                sendChord(codes)
            case "fullscreen":
                fullscreen = effect["value"] as? Bool == true
                setNeedsStatusBarAppearanceUpdate()
                setNeedsUpdateOfHomeIndicatorAutoHidden()
            case "keyboard":
                if effect["value"] as? Bool == true { keyboard.becomeFirstResponder() }
                else { keyboard.resignFirstResponder() }
            case "pasteShift": terminalPaste = effect["value"] as? Bool == true
            case "reverseScroll": reverseScroll = effect["value"] as? Bool == true
            case "clipboardSharing": clipboardSharing = effect["value"] as? Bool == true
            case "syncClipboard":
                if !stopped, inputEnabled, let metalView {
                    syncClipboard(Unmanaged.passUnretained(metalView).toOpaque())
                }
            case "pinchZoom": pinchZoom = effect["value"] as? Bool == true
            case "resetZoom": sendTouch(17, 0, 0, 0, 0)
            case "secureAttention": sendInput(["type": "secureAttention"])
            case "emit":
                if let event = effect["value"] as? [String: Any] { emit(event) }
            case "close": handleCloseTapped()
            default: break
            }
        }
        updateControls()
    }

    private func releaseInput(resetPan: Bool = true, forTyping: Bool = false,
                              preserveSelectedModifiers: Bool = false) {
        dragging = false
        dragLocked = false
        if resetPan { inputState.endPan() }
        if !preserveSelectedModifiers { modifiers.reset() }
        if !stopped, let metalView { resetHardwareKeys(Unmanaged.passUnretained(metalView).toOpaque()) }
        // Chord and committed-text batches include their own ordered release.
        if !forTyping { sendTouch(6, 0, 0, 0, 0) }
    }

    private func pressKey(_ code: String) {
        let selected = modifiers.take()
        releaseInput(forTyping: true)
        sendKey(code, modifiers: selected)
        updateControls()
    }

    @objc private func handleFocusLost() {
        releaseInput()
        keyboard.resignFirstResponder()
        updateControls()
        metalView?.resignFirstResponder()
        if let pointer { configurePointer(pointer, false, reverseScroll) }
    }

    @objc private func windowFocusChanged(_ notification: Notification) {
        guard let window = notification.object as? UIWindow, window === viewIfLoaded?.window else { return }
        if notification.name == UIWindow.didResignKeyNotification { handleFocusLost() }
        else { updateHardwareFocus() }
    }

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
        sendChord(modifiers + [code])
    }

    private func sendChord(_ codes: [String]) {
        guard !stopped, inputEnabled, let metalView else { return }
        let codes = codes as NSArray
        withExtendedLifetime(codes) {
            sendKeyChord(Unmanaged.passUnretained(metalView).toOpaque(), Unmanaged.passUnretained(codes).toOpaque())
        }
    }

    private func sendTouch(_ kind: Int32, _ x: Double, _ y: Double, _ dx: Double, _ dy: Double) {
        let video = metalView.map { Unmanaged.passUnretained($0).toOpaque() }
        deskfleetIosTouch(video, kind, x, y, dx, dy)
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
        else { sendTouch(relative ? 9 : 3, x, y, 0, 0) }
    }

    @objc private func handleLongPress(_ recognizer: UILongPressGestureRecognizer) {
        guard inputEnabled, recognizer.state == .began else { return }
        let (x, y) = scaledPoint(recognizer)
        sendTouch(relative ? 10 : 4, x, y, 0, 0)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        gestureRecognizer is UIPinchGestureRecognizer && other === pan
    }

    /// Pinch zoom is local presentation, so it needs a connection but not input control.
    @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
        switch recognizer.state {
        case .began, .changed:
            guard pinchZoom, connected else { return }
            if !pinching {
                pinching = true
                panSuppressed = true
                if dragging && !dragLocked { releaseInput(resetPan: false); updateControls() }
            }
            let (x, y) = scaledPoint(recognizer)
            sendTouch(15, x, y, Double(recognizer.scale), 0)
            recognizer.scale = 1
        default:
            guard pinching else { return }
            pinching = false
            sendTouch(16, 0, 0, 0, 0)
            if ![.began, .changed].contains(pan.state) { panSuppressed = false }
        }
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        if panSuppressed {
            recognizer.setTranslation(.zero, in: metalView)
            if [.ended, .cancelled, .failed].contains(recognizer.state) {
                panSuppressed = pinching
                inputState.endPan()
            }
            return
        }
        guard inputEnabled else { return }
        let (x, y) = scaledPoint(recognizer)
        let scale = metalView.contentScaleFactor
        let translation = recognizer.translation(in: metalView)
        recognizer.setTranslation(.zero, in: metalView)
        switch recognizer.state {
        case .began, .changed:
            if inputState.scrollPan(touches: recognizer.numberOfTouches) {
                if dragging || dragLocked { releaseInput(resetPan: false); updateControls() }
                let direction: CGFloat = reverseScroll ? 1 : -1
                sendTouch(relative ? 13 : 5, x, y, Double(direction * translation.x * scale), Double(direction * translation.y * scale))
            } else if relative {
                sendTouch(8, 0, 0, Double(translation.x * scale), Double(translation.y * scale))
            } else {
                if !dragging { dragging = true; sendTouch(1, x, y, 0, 0) }
                sendTouch(0, x, y, 0, 0)
            }
        case .cancelled, .failed:
            releaseInput()
            updateControls()
        case .ended:
            inputState.endPan()
            if dragging && !dragLocked {
                dragging = false
                sendTouch(relative ? 12 : 2, x, y, 0, 0)
            }
        default: break
        }
    }

    private func handleCloseTapped() {
        viewerVisible = false
        state["inputReady"] = false
        resetSession()
        releaseInput()
        keyboard.resignFirstResponder()
        if !closeSent { closeSent = true; sendTouch(7, 0, 0, 0, 0) }
        detachWindow()
        dismiss(animated: false)
    }

    @objc private func handleDidBecomeActive() {
        updateHardwareFocus()
    }

    private func resetSession() {
        guard !stopped, let metalView else { return }
        resetVideoSession(Unmanaged.passUnretained(metalView).toOpaque())
    }
}
