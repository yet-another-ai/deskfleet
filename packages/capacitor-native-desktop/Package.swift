// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DeskfleetCapacitorNativeDesktop",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "DeskfleetCapacitorNativeDesktop",
            targets: ["NativeDesktopPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .binaryTarget(
            name: "DeskfleetDesktopViewerFFI",
            path: "ios/Frameworks/DeskfleetDesktopViewerFFI.xcframework"
        ),
        .target(
            name: "NativeDesktopPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "DeskfleetDesktopViewerFFI"
            ],
            path: "ios/Sources/NativeDesktopPlugin",
            linkerSettings: [
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("CoreFoundation"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("Foundation"),
                .linkedFramework("IOSurface"),
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("Security"),
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("UIKit"),
                .linkedFramework("VideoToolbox"),
                .linkedLibrary("c++"),
                .linkedLibrary("resolv")
            ]
        )
    ]
)
