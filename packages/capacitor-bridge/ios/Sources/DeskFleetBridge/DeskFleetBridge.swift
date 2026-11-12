import AuthenticationServices
import Capacitor
import Foundation
import ReplayKit
import UIKit

@_silgen_name("deskfleet_ios_start")
internal func deskfleetIosStart(_ onEvent: (@convention(c) (UnsafePointer<CChar>?) -> Void)?)

@_silgen_name("deskfleet_ios_send_command")
internal func deskfleetIosSendCommand(_ commandJson: UnsafePointer<CChar>?)

@_silgen_name("deskfleet_ios_stop")
internal func deskfleetIosStop()

@_silgen_name("deskfleet_ios_surface_created")
internal func deskfleetIosSurfaceCreated(_ layer: UnsafeMutableRawPointer?, _ width: UInt32, _ height: UInt32)

@_silgen_name("deskfleet_ios_surface_changed")
internal func deskfleetIosSurfaceChanged(_ width: UInt32, _ height: UInt32)

@_silgen_name("deskfleet_ios_surface_destroyed")
internal func deskfleetIosSurfaceDestroyed()

@_silgen_name("deskfleet_ios_touch")
internal func deskfleetIosTouch(_ kind: Int32, _ x: Double, _ y: Double, _ dx: Double, _ dy: Double)

@_silgen_name("deskfleet_ios_test_nat")
internal func deskfleetIosTestNat(_ server: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("deskfleet_ios_string_free")
internal func deskfleetIosStringFree(_ ptr: UnsafeMutablePointer<CChar>?)

private let viewerEventCallback: @convention(c) (UnsafePointer<CChar>?) -> Void = { payloadPtr in
    guard let payloadPtr else { return }
    DeskFleetBridge.activePlugin?.notifyListeners("viewerEvent", data: ["payload": String(cString: payloadPtr)])
}

@objc(DeskFleetBridge)
public class DeskFleetBridge: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "DeskFleetBridge"
    public let jsName = "DeskFleetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testNat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "outlineAudioStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startOutlineAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopOutlineAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelSpeech", returnType: CAPPluginReturnPromise)
    ]

    nonisolated(unsafe) internal static weak var activePlugin: DeskFleetBridge?
    nonisolated(unsafe) internal static weak var activeController: RemoteDesktopViewController?
    private var authSession: ASWebAuthenticationSession?
    private var speechInput: SpeechInput?

    private func speech() -> SpeechInput {
        if let speechInput { return speechInput }
        let input = SpeechInput { [weak self] event in
            self?.notifyListeners("speechEvent", data: event)
        }
        speechInput = input
        return input
    }

    @objc func speechStatus(_ call: CAPPluginCall) {
        let locale = call.getString("locale") ?? Locale.current.identifier
        DispatchQueue.main.async { [weak self] in
            call.resolve(["supported": self?.speech().isSupported(locale: locale) ?? false])
        }
    }

    @objc func startSpeech(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId"), !id.isEmpty,
              let locale = call.getString("locale"), !locale.isEmpty else {
            call.reject("Missing speech session ID or locale")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("Speech bridge unavailable", "unavailable") }
            self.speech().start(id: id, locale: locale) { call.resolve() }
        }
    }

    @objc func stopSpeech(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let id = call.getString("sessionId") { self?.speechInput?.stop(id: id) }
            call.resolve()
        }
    }

    @objc func cancelSpeech(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let id = call.getString("sessionId") { self?.speechInput?.cancel(id: id) }
            call.resolve()
        }
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        guard let rawUrl = call.getString("url"),
              let url = URL(string: rawUrl),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let callbackScheme = call.getString("callbackScheme"),
              !callbackScheme.isEmpty else {
            call.reject("Invalid authentication parameters")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("Bridge unavailable")
                return
            }
            self.authSession?.cancel()

            weak var createdSession: ASWebAuthenticationSession?
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                DispatchQueue.main.async {
                    if let createdSession, self?.authSession === createdSession {
                        self?.authSession = nil
                    }
                    if let error {
                        if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                            call.reject("Sign-in canceled", "CANCELED", error)
                        } else {
                            call.reject(error.localizedDescription, nil, error)
                        }
                        return
                    }
                    guard let callbackURL else {
                        call.reject("Missing authentication callback URL")
                        return
                    }
                    call.resolve(["url": callbackURL.absoluteString])
                }
            }
            createdSession = session
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.authSession = session

            if !session.start() {
                self.authSession = nil
                call.reject("Failed to start authentication session")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            self.bridge?.viewController?.viewIfLoaded?.window
                ?? UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .flatMap(\.windows)
                    .first(where: \.isKeyWindow)
                ?? ASPresentationAnchor()
        }
    }

    private lazy var sharedStore = OutlineAudioSharedStore()
    private var pollTimer: DispatchSourceTimer?
    private var pendingStartCall: CAPPluginCall?
    private var pickerView: RPSystemBroadcastPickerView?
    private var appLifecycleObservers: [NSObjectProtocol] = []
    private var pickerPresented = false
    private var startDeadlineMs: UInt64 = 0
    private var lastAudioTs: UInt64 = 0

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let root = self.bridge?.viewController else {
                call.reject("Activity unavailable")
                return
            }
            Self.activePlugin = self
            deskfleetIosStart(viewerEventCallback)
            Self.activeController?.dismiss(animated: false)

            let controller = RemoteDesktopViewController()
            controller.modalPresentationStyle = .fullScreen
            Self.activeController = controller

            var presenter: UIViewController = root
            while let next = presenter.presentedViewController, !next.isBeingDismissed {
                presenter = next
            }
            presenter.present(controller, animated: false) { call.resolve() }
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let command = call.getString("command"), !command.isEmpty else {
            call.reject("Missing command payload")
            return
        }
        command.withCString { deskfleetIosSendCommand($0) }
        call.resolve()
    }

    @objc func close(_ call: CAPPluginCall) {
        Self.stopSession()
        call.resolve()
    }

    @objc func testNat(_ call: CAPPluginCall) {
        guard let server = call.getString("server"), !server.isEmpty else {
            call.reject("Missing STUN server")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            guard let ptr = server.withCString({ deskfleetIosTestNat($0) }) else {
                call.reject("Failed to test NAT")
                return
            }
            defer { deskfleetIosStringFree(ptr) }
            guard let data = String(cString: ptr).data(using: .utf8),
                  let response = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                call.reject("Invalid NAT test response")
                return
            }
            if let error = response["error"] as? String, !error.isEmpty {
                call.reject(error)
                return
            }
            guard let result = response["result"] as? JSObject else {
                call.reject("Missing NAT test result")
                return
            }
            call.resolve(result)
        }
    }

    @objc func outlineAudioStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.resolve(["supported": false, "active": false]) }
            let active = self.sharedStore?.isCurrentlyActive() ?? false
            if active { self.startPollingBands() }
            call.resolve(["supported": self.sharedStore != nil, "active": active])
        }
    }

    @objc func startOutlineAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let root = self.bridge?.viewController, let store = self.sharedStore else {
                call.reject("System audio broadcast is unavailable.", "unavailable")
                return
            }
            if store.isCurrentlyActive() {
                self.startPollingBands()
                call.resolve(["started": true])
                return
            }

            self.resolvePendingStart(started: false)
            store.setStopRequested(false)
            self.pendingStartCall = call
            self.pickerPresented = false
            self.startDeadlineMs = OutlineAudioSharedStore.nowMs() + 2_000

            let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
            picker.preferredExtension = "\(Bundle.main.bundleIdentifier ?? "ai.yetanother.deskfleet").BroadcastUpload"
            picker.showsMicrophoneButton = false
            picker.isHidden = true
            picker.isUserInteractionEnabled = false
            root.view.addSubview(picker)
            self.pickerView = picker

            guard let button = picker.subviews.compactMap({ $0 as? UIButton }).first else {
                self.resolvePendingStart(started: false, failure: "Broadcast picker is unavailable.")
                return
            }

            let center = NotificationCenter.default
            self.appLifecycleObservers = [
                center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    self?.pickerPresented = true
                    self?.startDeadlineMs = .max
                },
                center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    guard let self, self.pickerPresented else { return }
                    self.startDeadlineMs = OutlineAudioSharedStore.nowMs() + 1_500
                }
            ]
            self.startPollingBands()
            button.sendActions(for: .touchUpInside)
        }
    }

    @objc func stopOutlineAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.resolvePendingStart(started: false)
            self?.stopPollingBands()
            self?.sharedStore?.setStopRequested(true)
            call.resolve()
        }
    }

    private func resolvePendingStart(started: Bool, failure: String? = nil) {
        for observer in appLifecycleObservers { NotificationCenter.default.removeObserver(observer) }
        appLifecycleObservers.removeAll()
        pickerView?.removeFromSuperview()
        pickerView = nil
        guard let call = pendingStartCall else { return }
        pendingStartCall = nil
        if let failure { call.reject(failure, "unavailable") }
        else { call.resolve(["started": started]) }
    }

    private func startPollingBands() {
        guard pollTimer == nil else { return }
        lastAudioTs = 0
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(22), repeating: .milliseconds(22), leeway: .milliseconds(4))
        timer.setEventHandler { [weak self] in self?.pollSharedSpectrum() }
        pollTimer = timer
        timer.resume()
    }

    private func stopPollingBands() {
        pollTimer?.cancel()
        pollTimer = nil
    }

    private func pollSharedSpectrum() {
        guard let store = sharedStore else { return }
        let nowMs = OutlineAudioSharedStore.nowMs()
        let (alive, sampleRate, binsBase64) = store.readState(nowMs: nowMs, lastAudioTs: &lastAudioTs)

        if pendingStartCall != nil {
            if alive {
                resolvePendingStart(started: true)
            } else if nowMs >= startDeadlineMs {
                stopPollingBands()
                resolvePendingStart(started: false, failure: pickerPresented ? nil : "Broadcast picker did not appear.")
            }
            return
        }

        guard alive else {
            stopPollingBands()
            notifyListeners("outlineAudioStopped", data: [:])
            return
        }

        if let binsBase64 {
            notifyListeners("outlineAudioBands", data: ["sampleRate": sampleRate, "bins": binsBase64])
        }
    }

    deinit {
        let speech = speechInput
        DispatchQueue.main.async { speech?.dispose() }
        pollTimer?.cancel()
        for observer in appLifecycleObservers { NotificationCenter.default.removeObserver(observer) }
        let session = authSession
        authSession = nil
        if Thread.isMainThread {
            session?.cancel()
        } else {
            DispatchQueue.main.async { session?.cancel() }
        }
        Self.stopSession()
    }

    internal static func stopSession() {
        deskfleetIosStop()
        DispatchQueue.main.async {
            guard let controller = activeController else { return }
            activeController = nil
            controller.prepareForExternalStop()
            if !controller.isBeingDismissed { controller.dismiss(animated: false) }
        }
    }
}
