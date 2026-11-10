import Capacitor
import Foundation
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
public class DeskFleetBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeskFleetBridge"
    public let jsName = "DeskFleetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testNat", returnType: CAPPluginReturnPromise)
    ]

    nonisolated(unsafe) internal static weak var activePlugin: DeskFleetBridge?
    nonisolated(unsafe) internal static weak var activeController: RemoteDesktopViewController?

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

    deinit { Self.stopSession() }

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
