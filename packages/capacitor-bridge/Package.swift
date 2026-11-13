// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DeskfleetCapacitorBridge",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "DeskfleetCapacitorBridge",
            targets: ["DeskFleetBridge"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.6.2")
    ],
    targets: [
        .binaryTarget(
            name: "DeskfleetDesktopViewerFFI",
            path: "ios/Frameworks/DeskfleetDesktopViewerFFI.xcframework"
        ),
        .target(
            name: "DeskFleetBridge",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "DeskfleetDesktopViewerFFI"
            ],
            path: "ios/Sources/DeskFleetBridge",
            resources: [.process("PrivacyInfo.xcprivacy")],
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AuthenticationServices"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("CoreFoundation"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("Foundation"),
                .linkedFramework("IOSurface"),
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("ReplayKit"),
                .linkedFramework("Security"),
                .linkedFramework("Speech"),
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("UIKit"),
                .linkedFramework("VideoToolbox"),
                .linkedLibrary("c++"),
                .linkedLibrary("resolv")
            ]
        )
    ]
)
