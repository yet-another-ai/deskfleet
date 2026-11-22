import UIKit

@_silgen_name("deskfleet_ios_mount_window")
private func mountWindow(_ root: UnsafeMutableRawPointer, _ keyboard: UnsafeMutableRawPointer,
                         _ controls: UnsafeMutableRawPointer) -> UnsafeMutableRawPointer
@_silgen_name("deskfleet_ios_send_key_chord")
private func sendKeyChord(_ codes: UnsafeRawPointer)
@_silgen_name("deskfleet_ios_video_stop")
private func stopVideo(_ video: UnsafeMutableRawPointer)

@_silgen_name("deskfleet_ios_pointer_install")
private func installPointer(_ video: UnsafeMutableRawPointer) -> UnsafeMutableRawPointer?
@_silgen_name("deskfleet_ios_pointer_configure")
private func configurePointer(_ pointer: UnsafeMutableRawPointer, _ enabled: Bool, _ reverseScroll: Bool)

final class RemoteDesktopViewController: UIViewController, UIGestureRecognizerDelegate {
    private static let maxClipboardBytes = 32 * 1024
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
    private var paused: Bool {
        get { inputState.paused }
        set { inputState.paused = newValue }
    }
    private var terminalPaste = false
    private var dragging = false
    private var dragLocked = false
    private var viewerVisible = false
    private var closeSent = false
    private var lastSyncedClipboard: String?
    private var lastPasteboardChangeCount: Int = UIPasteboard.general.changeCount

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
        center.addObserver(self, selector: #selector(handlePasteboardChanged), name: UIPasteboard.changedNotification, object: nil)
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
        if !closeSent { handleFocusLost() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        detachWindow()
        if DeskFleetBridge.activeController === self { DeskFleetBridge.activeController = nil }
        if isBeingDismissed && !closeSent { closeSent = true; deskfleetIosTouch(7, 0, 0, 0, 0) }
    }

    private func detachWindow() {
        NotificationCenter.default.removeObserver(self)
        if let metalView { stopVideo(Unmanaged.passUnretained(metalView).toOpaque()) }
        controls.stop()
    }

    func prepareForExternalStop() {
        guard !closeSent else { return }
        viewerVisible = false
        closeSent = true
        releaseInput()
        keyboard.resignFirstResponder()
        updateHardwareFocus()
        detachWindow()
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
            if inputState.reconcile(status: next["status"] as? String,
                                    control: next["control"] as? Bool == true,
                                    inputReady: next["inputReady"] as? Bool == true) {
                send(["type": "pauseInput", "paused": false])
            }
            if wasEnabled && !inputEnabled || changedDisplay {
                releaseInput()
                keyboard.resignFirstResponder()
                hackerOpen = false
            }
            if changedDisplay { deskfleetIosTouch(14, 0, 0, 0, 0) }
            updateControls()
        } else if ["stop", "close"].contains(command["type"] as? String ?? "") {
            state.removeValue(forKey: "inputReady")
            updateHardwareFocus()
            releaseInput()
            keyboard.resignFirstResponder()
        }
    }

    private func updateHardwareFocus() {
        guard let metalView else { return }
        let activeInput = viewerVisible && inputEnabled && view.window?.isKeyWindow == true
            && view.window?.windowScene?.activationState == .foregroundActive
        if let pointer { configurePointer(pointer, activeInput, reverseScroll) }
        let capture = activeInput && !keyboard.isFirstResponder && !controls.ownsKeyboardFocus
        if capture && !metalView.isFirstResponder { metalView.becomeFirstResponder() }
        if !capture && metalView.isFirstResponder { metalView.resignFirstResponder() }
    }

    private func updateControls() {
        updateHardwareFocus()
        controls.update(state: state, relative: relative, paused: paused, dragging: dragLocked,
                        keyboard: keyboard.isFirstResponder, hacker: hackerOpen, terminalPaste: terminalPaste,
                        modifiers: modifiers.selected, reverseScroll: reverseScroll,
                        clipboardSharing: clipboardSharing, fullscreen: fullscreen, pinchZoom: pinchZoom)
        view.setNeedsLayout()
    }

    private func handleAction(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "toggleCollapsed", "togglePanel":
            releaseInput()
            hackerOpen = false
        case "toggleMouseMode":
            releaseInput()
            relative.toggle()
            deskfleetIosTouch(14, 0, 0, 0, 0)
        case "toggleKeyboard" where inputEnabled:
            // Selected Hacker modifiers are local; opening the IME releases any
            // remote drag while keeping the next Ctrl/Alt shortcut available.
            let selected = modifiers
            releaseInput()
            modifiers = selected
            if keyboard.isFirstResponder { keyboard.resignFirstResponder() }
            else { keyboard.becomeFirstResponder() }
        case "toggleHackerKeyboard" where inputEnabled:
            releaseInput()
            hackerOpen.toggle()
        case "toggleControl":
            releaseInput()
            paused.toggle()
            send(["type": "pauseInput", "paused": paused])
            if paused { keyboard.resignFirstResponder(); hackerOpen = false }
        case "setControl":
            releaseInput()
            if paused { paused = false; send(["type": "pauseInput", "paused": false]) }
            emit(["type": "setControl", "control": event["value"] as? Bool == true])
        case "selectDisplay":
            guard let id = event["value"] as? Int else { return }
            releaseInput()
            emit(["type": "selectDisplay", "displayId": id])
        case "toggleDrag" where inputEnabled:
            dragLocked.toggle()
            if relative { deskfleetIosTouch(dragLocked ? 11 : 12, 0, 0, 0, 0) }
            else if !dragLocked { releaseInput() }
        case "syncClipboard" where inputEnabled: syncLocalClipboardToRemote(force: true)
        case "setPasteShift": terminalPaste = event["value"] as? Bool == true
        case "setReverseScroll": reverseScroll = event["value"] as? Bool == true
        case "setClipboardSharing": clipboardSharing = event["value"] as? Bool == true
        case "toggleFullscreen":
            fullscreen.toggle()
            setNeedsStatusBarAppearanceUpdate()
            setNeedsUpdateOfHomeIndicatorAutoHidden()
        case "toggleModifier" where inputEnabled:
            if let code = event["value"] as? String { modifiers.toggle(code) }
        case "key" where inputEnabled:
            if let code = event["value"] as? String { pressKey(code) }
        case "secureAttention" where inputEnabled: sendInput(["type": "secureAttention"])
        case "shortcut" where inputEnabled:
            guard let codes = event["value"] as? [String], let key = codes.last else { return }
            releaseInput(forTyping: true)
            sendKey(key, modifiers: Array(codes.dropLast()))
        case "setPinchZoom":
            pinchZoom = event["value"] as? Bool == true
            if !pinchZoom { deskfleetIosTouch(17, 0, 0, 0, 0) }
        case "resetZoom": deskfleetIosTouch(17, 0, 0, 0, 0)
        case "reconnect", "disconnect":
            releaseInput()
            emit(["type": event["type"] as? String ?? "disconnect"])
        case "focusHandle": releaseInput()
        case "selectOpen" where event["value"] as? Bool == true: releaseInput()
        case "close": handleCloseTapped()
        default: break
        }
        updateControls()
    }

    private func releaseInput(resetPan: Bool = true, forTyping: Bool = false) {
        dragging = false
        dragLocked = false
        if resetPan { inputState.endPan() }
        modifiers.reset()
        if let metalView { resetHardwareKeys(Unmanaged.passUnretained(metalView).toOpaque()) }
        // Chord and committed-text batches include their own ordered release.
        if !forTyping { deskfleetIosTouch(6, 0, 0, 0, 0) }
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
        guard inputEnabled else { return }
        let codes = (modifiers + [code]) as NSArray
        withExtendedLifetime(codes) { sendKeyChord(Unmanaged.passUnretained(codes).toOpaque()) }
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
            deskfleetIosTouch(15, x, y, Double(recognizer.scale), 0)
            recognizer.scale = 1
        default:
            guard pinching else { return }
            pinching = false
            deskfleetIosTouch(16, 0, 0, 0, 0)
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
                deskfleetIosTouch(relative ? 13 : 5, x, y, Double(direction * translation.x * scale), Double(direction * translation.y * scale))
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
            inputState.endPan()
            if dragging && !dragLocked {
                dragging = false
                deskfleetIosTouch(relative ? 12 : 2, x, y, 0, 0)
            }
        default: break
        }
    }

    private func handleCloseTapped() {
        viewerVisible = false
        releaseInput()
        keyboard.resignFirstResponder()
        if !closeSent { closeSent = true; deskfleetIosTouch(7, 0, 0, 0, 0) }
        detachWindow()
        dismiss(animated: false)
    }

    @objc private func handleDidBecomeActive() {
        updateHardwareFocus()
        syncLocalClipboardToRemote(force: false)
    }
    @objc private func handlePasteboardChanged() { syncLocalClipboardToRemote(force: false) }

    func applyRemoteClipboard(_ rawText: String) {
        guard clipboardSharing else { return }
        let sanitized = rawText.replacingOccurrences(of: "\0", with: "")
        guard !sanitized.isEmpty, sanitized.utf8.count <= Self.maxClipboardBytes,
              sanitized != lastSyncedClipboard else { return }
        lastSyncedClipboard = sanitized
        UIPasteboard.general.string = sanitized
        lastPasteboardChangeCount = UIPasteboard.general.changeCount
    }

    private func syncLocalClipboardToRemote(force: Bool) {
        guard inputEnabled && (force || clipboardSharing) else { return }
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
