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
    private let metalView = MetalVideoView(frame: .zero)
    private var dragging = false
    private var closeSent = false

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        metalView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(metalView)

        let closeButton = UIButton(type: .custom)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("✕", for: .normal)
        closeButton.setTitleColor(.white, for: .normal)
        closeButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .medium)
        closeButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        closeButton.accessibilityLabel = "Disconnect"
        closeButton.backgroundColor = UIColor(red: 20 / 255, green: 20 / 255, blue: 24 / 255, alpha: 140 / 255)
        closeButton.layer.cornerRadius = 18
        closeButton.layer.borderWidth = 1
        closeButton.layer.borderColor = UIColor(white: 1, alpha: 90 / 255).cgColor
        closeButton.addTarget(self, action: #selector(handleCloseTapped), for: .touchUpInside)
        view.addSubview(closeButton)

        NSLayoutConstraint.activate([
            metalView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            metalView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            metalView.topAnchor.constraint(equalTo: view.topAnchor),
            metalView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            closeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16)
        ])

        metalView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:))))
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = 0.5
        metalView.addGestureRecognizer(longPress)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 2
        metalView.addGestureRecognizer(pan)

        NotificationCenter.default.addObserver(
            self, selector: #selector(handleFocusLost), name: UIApplication.willResignActiveNotification, object: nil
        )
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
        if NativeDesktopPlugin.activeController === self { NativeDesktopPlugin.activeController = nil }
        if isBeingDismissed && !closeSent {
            closeSent = true
            deskfleetIosTouch(7, 0, 0, 0, 0)
        }
    }

    func prepareForExternalStop() {
        closeSent = true
        dragging = false
        metalView.detachSurface()
    }

    @objc private func handleFocusLost() {
        dragging = false
        deskfleetIosTouch(6, 0, 0, 0, 0)
    }

    private func scaledPoint(_ recognizer: UIGestureRecognizer) -> (Double, Double) {
        let p = recognizer.location(in: metalView)
        let s = metalView.contentScaleFactor
        return (Double(p.x * s), Double(p.y * s))
    }

    @objc private func handleSingleTap(_ r: UITapGestureRecognizer) {
        guard r.state == .ended else { return }
        let (x, y) = scaledPoint(r)
        deskfleetIosTouch(3, x, y, 0, 0)
    }

    @objc private func handleLongPress(_ r: UILongPressGestureRecognizer) {
        guard r.state == .began else { return }
        let (x, y) = scaledPoint(r)
        deskfleetIosTouch(4, x, y, 0, 0)
    }

    @objc private func handlePan(_ r: UIPanGestureRecognizer) {
        let (x, y) = scaledPoint(r)
        let s = metalView.contentScaleFactor
        let t = r.translation(in: metalView)
        r.setTranslation(.zero, in: metalView)

        switch r.state {
        case .began, .changed:
            if r.numberOfTouches >= 2 {
                if dragging { dragging = false; deskfleetIosTouch(2, x, y, 0, 0) }
                deskfleetIosTouch(5, x, y, Double(-t.x * s), Double(-t.y * s))
            } else {
                if !dragging { dragging = true; deskfleetIosTouch(1, x, y, 0, 0) }
                deskfleetIosTouch(0, x, y, 0, 0)
            }
        case .ended, .cancelled, .failed:
            if dragging { dragging = false; deskfleetIosTouch(2, x, y, 0, 0) }
        default: break
        }
    }

    @objc private func handleCloseTapped() {
        if !closeSent { closeSent = true; deskfleetIosTouch(7, 0, 0, 0, 0) }
        metalView.detachSurface()
        dismiss(animated: false)
    }
}
