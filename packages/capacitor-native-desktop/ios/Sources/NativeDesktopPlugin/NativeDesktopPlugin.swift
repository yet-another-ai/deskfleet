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

private let viewerEventCallback: @convention(c) (UnsafePointer<CChar>?) -> Void = { payloadPtr in
    guard let payloadPtr else { return }
    NativeDesktopPlugin.activePlugin?.notifyListeners("viewerEvent", data: ["payload": String(cString: payloadPtr)])
}

@objc(NativeDesktopPlugin)
public class NativeDesktopPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeDesktopPlugin"
    public let jsName = "NativeDesktop"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    nonisolated(unsafe) internal static weak var activePlugin: NativeDesktopPlugin?
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
