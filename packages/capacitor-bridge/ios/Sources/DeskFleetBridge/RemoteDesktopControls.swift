import UIKit

@_silgen_name("deskfleet_ios_controls_create")
private func createControls(_ wrapper: UnsafeMutableRawPointer, _ identity: UInt64, _ callback: @convention(c) (UInt64, UnsafePointer<CChar>?) -> Void) -> UnsafeMutableRawPointer?
@_silgen_name("deskfleet_ios_controls_hit")
private func controlsHit(_ handle: UnsafeMutableRawPointer, _ x: Float, _ y: Float, _ grip: Bool) -> Bool
@_silgen_name("deskfleet_ios_controls_drag")
private func controlsDrag(_ handle: UnsafeMutableRawPointer, _ dx: Float, _ dy: Float)
@_silgen_name("deskfleet_ios_controls_owns_focus")
private func controlsOwnFocus(_ handle: UnsafeMutableRawPointer) -> Bool
@_silgen_name("deskfleet_ios_controls_update")
private func updateControls(_ handle: UnsafeMutableRawPointer, _ json: UnsafePointer<CChar>)
@_silgen_name("deskfleet_ios_controls_destroy")
private func destroyControls(_ handle: UnsafeMutableRawPointer)
@_silgen_name("deskfleet_ios_control_effects")
private func controlEffects(_ state: UnsafePointer<CChar>, _ action: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("deskfleet_ios_control_effects_free")
private func freeControlEffects(_ effects: UnsafeMutablePointer<CChar>)

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
        RemoteDesktopControls.instances[identity]?.value?.action?(action)
    }
}

/// Owns the shared Rust UI's UIView and the platform geometry/touch boundary.
final class RemoteDesktopControls: UIView, UIGestureRecognizerDelegate {
    fileprivate static var instances: [UInt64: WeakControls] = [:]
    private let identity = UInt64.random(in: 1...UInt64.max)
    private var handle: UnsafeMutableRawPointer?
    var action: (([String: Any]) -> Void)?
    var ownsKeyboardFocus: Bool { handle.map(controlsOwnFocus) ?? false }
    private var snapshot: [String: Any] = [:]

    init() {
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        Self.instances[identity] = WeakControls(self)
        handle = createControls(Unmanaged.passUnretained(self).toOpaque(), identity, controlsCallback)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
        pan.delegate = self
        addGestureRecognizer(pan)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        Self.instances.removeValue(forKey: identity)
        if let handle { destroyControls(handle) }
    }

    func stop() {
        Self.instances.removeValue(forKey: identity)
        if let handle { destroyControls(handle); self.handle = nil }
    }

    func update(state: RemoteDesktopControlState) {
        snapshot = state.snapshot
        setNeedsLayout()
    }

    func effects(for action: [String: Any], state: RemoteDesktopControlState) -> [[String: Any]] {
        precondition(Thread.isMainThread)
        // Use the controller's live state, never the last layout's snapshot.
        guard let stateData = try? JSONSerialization.data(withJSONObject: state.snapshot),
              let stateJSON = String(data: stateData, encoding: .utf8),
              let actionData = try? JSONSerialization.data(withJSONObject: action),
              let actionJSON = String(data: actionData, encoding: .utf8) else { return [] }
        return stateJSON.withCString { statePointer in
            actionJSON.withCString { actionPointer in
                guard let result = controlEffects(statePointer, actionPointer) else { return [] }
                defer { freeControlEffects(result) }
                let data = Data(String(cString: result).utf8)
                return (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
            }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let handle, !snapshot.isEmpty, bounds.width > 0, bounds.height > 0 else { return }
        snapshot["dark"] = traitCollection.userInterfaceStyle == .dark
        snapshot["viewport"] = [bounds.width, bounds.height]
        guard let data = try? JSONSerialization.data(withJSONObject: snapshot),
              let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { updateControls(handle, $0) }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let handle, controlsHit(handle, Float(point.x), Float(point.y), false) else { return nil }
        return super.hitTest(point, with: event)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        let point = touch.location(in: self)
        return handle.map { controlsHit($0, Float(point.x), Float(point.y), true) } ?? false
    }

    @objc private func drag(_ pan: UIPanGestureRecognizer) {
        guard let handle, pan.state == .began || pan.state == .changed else { return }
        if pan.state == .began { action?(["type": "focusHandle"]) }
        let delta = pan.translation(in: self)
        pan.setTranslation(.zero, in: self)
        controlsDrag(handle, Float(delta.x), Float(delta.y))
    }
}
