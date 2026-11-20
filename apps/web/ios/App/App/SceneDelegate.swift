import UIKit
import WebKit
import Capacitor

final class RootViewController: UIViewController {
    private static let desktopBreakpoint: CGFloat = 900
    private let bridgeViewController = CAPBridgeViewController()
    private var webViewObservations: [NSKeyValueObservation] = []
    private var transitionTargetWidth: CGFloat?
    private var lastDisablesVerticalBar: Bool?
    private var installedInitialUserScript = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark
                ? UIColor(red: 23.0 / 255.0, green: 25.0 / 255.0, blue: 31.0 / 255.0, alpha: 1.0)
                : UIColor(red: 251.0 / 255.0, green: 251.0 / 255.0, blue: 253.0 / 255.0, alpha: 1.0)
        }

        addChild(bridgeViewController)
        let bridgeView = bridgeViewController.view!
        bridgeView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bridgeView)

        NSLayoutConstraint.activate([
            bridgeView.topAnchor.constraint(equalTo: view.topAnchor),
            bridgeView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            bridgeView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bridgeView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        bridgeViewController.didMove(toParent: self)

        if let webView = bridgeViewController.webView {
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webViewObservations = [
                webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
                    MainActor.assumeIsolated { self?.syncWebViewVerticalBarEdge() }
                },
                webView.observe(\.url, options: [.new]) { [weak self] _, _ in
                    MainActor.assumeIsolated { self?.syncWebViewVerticalBarEdge() }
                },
            ]
        }

        if #available(iOS 27.1, *) {
            registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (self: Self, _) in
                self.syncVerticalBarConfiguration()
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncVerticalBarConfiguration()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        transitionTargetWidth = size.width
        syncVerticalBarConfiguration()
        coordinator.animate(alongsideTransition: { _ in
            self.syncVerticalBarConfiguration()
        }, completion: { _ in
            self.transitionTargetWidth = nil
            self.syncVerticalBarConfiguration()
        })
    }

    @available(iOS 27.1, *)
    private var resolvedVerticalBarSide: String? {
        let sceneEdge = view.window?.windowScene?.traitCollection.verticalBarEdge ?? .unspecified
        let edge = sceneEdge != .unspecified ? sceneEdge : traitCollection.verticalBarEdge
        let isRTL = view.effectiveUserInterfaceLayoutDirection == .rightToLeft
        switch edge {
        case .trailing:
            return isRTL ? "left" : "right"
        case .leading:
            return isRTL ? "right" : "left"
        case .unspecified:
            return nil
        @unknown default:
            return nil
        }
    }

    @available(iOS 27.1, *)
    private var shouldDisableVerticalBar: Bool {
        let width = transitionTargetWidth ?? view.bounds.width
        return resolvedVerticalBarSide != nil && width >= Self.desktopBreakpoint
    }

    private func syncVerticalBarConfiguration() {
        if #available(iOS 27.1, *) {
            let disables = shouldDisableVerticalBar
            if lastDisablesVerticalBar != disables {
                lastDisablesVerticalBar = disables
                setNeedsUpdateOfVerticalBarConfiguration()
            }
        }
        syncWebViewVerticalBarEdge()
    }

    private func syncWebViewVerticalBarEdge() {
        guard #available(iOS 27.1, *), let webView = bridgeViewController.webView else { return }
        let side = resolvedVerticalBarSide
        if let side, !installedInitialUserScript {
            installedInitialUserScript = true
            let bootstrap = WKUserScript(
                source: "document.documentElement.dataset.verticalBarEdge = '\(side)';",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            webView.configuration.userContentController.addUserScript(bootstrap)
        }
        let script = if let side {
            "if (document.documentElement) document.documentElement.dataset.verticalBarEdge = '\(side)';"
        } else {
            "if (document.documentElement) delete document.documentElement.dataset.verticalBarEdge;"
        }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    override var childForStatusBarStyle: UIViewController? {
        bridgeViewController
    }

    override var childForStatusBarHidden: UIViewController? {
        bridgeViewController
    }

    @available(iOS 27.1, *)
    override var preferredVerticalBarBehavior: UIVerticalBarBehavior {
        shouldDisableVerticalBar ? .disabled : .automatic
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        bridgeViewController.supportedInterfaceOrientations
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = RootViewController()
        window.makeKeyAndVisible()
        self.window = window

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
