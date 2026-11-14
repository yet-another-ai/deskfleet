# DeskFleet Kotlin Multiplatform Frontend (Experimental)

Experimental Kotlin Multiplatform + Compose Multiplatform rewrite of the DeskFleet frontend covering all six client targets from a single shared codebase:

- **Desktop**: macOS (`.dmg` / `.app`), Linux (`.deb`), Windows (`.msi`)
- **Mobile**: Android (`APK` / `AAB`), iOS (`ComposeApp.framework` + `iosApp` Xcode host)
- **Web (PWA)**: Kotlin/Wasm (`wasmJsBrowserDistribution`) served directly by `deskfleet-server` via `DESKFLEET_WEB_DIRECTORY` or any static host

## Architecture

- `composeApp/src/commonMain`: Shared UI components, OKLCH theme, spring motion physics, i18n (`en-US`, `zh-cmn-Hans-CN`, `ja-JP`), `(teamId, machineId)` scoped state stores, `HttpCentralClient` (Bearer + HttpOnly Cookie/CSRF + `/api/client/ws` signaling), `fixed4-v1` binary multiplexer, ACP session stream projector, VT100/xterm terminal emulator, two-pane file manager, remote desktop canvas, system telemetry charts, schedules, search, billing, and site administration.
- `composeApp/src/desktopMain`: Local daemon IPC (`daemon.json` over Unix Domain Socket / Windows Named Pipe), local machine enrollment, native `deskfleet-viewer` launcher, external editor launchers, macOS traffic-light and Windows/Linux window-control insets, system tray, and startup preferences.
- `composeApp/src/androidMain` & `androidApp`: Android JNI WebRTC/H.264 bridge, `deskfleet://` PKCE deep links, Custom Tabs, haptic feedback, and mobile store billing policy compliance.
- `composeApp/src/iosMain` & `iosApp`: Kotlin/Native `cinterop` static linkage against `libdeskfleet_kmp_bridge.a`, `ASWebAuthenticationSession` / deep-link callback handling, UIKit clipboard/haptics, and SwiftUI host wrapper.
- `composeApp/src/wasmJsMain`: Browser native `RTCPeerConnection` + `RTCDataChannel` + `<video>` H.264 frame capture, `HttpOnly` cookie + `X-CSRF-Token` session mode, `/auth/*` routes (`/auth/login`, `/auth/register`, `/auth/recovery`, `/auth/verify`, `/auth/recovery/complete`, `/auth/desktop` PKCE approval, `/auth/email/verify`, `/auth/account`), WebAuthn Passkeys, browser file downloads, and installable PWA manifest.
- `rust-bridge`: Thin Rust native library (`webrtc-rs`, `openh264`, RFC 5780 STUN NAT probe) exposing JNI symbols for Desktop/Android and C ABI symbols for iOS.

## Build and Run

Run from `experimental/kmp-frontend`:

```sh
# Desktop live run
mise exec -- ./gradlew :composeApp:run

# Desktop native bundle (.app / .dmg / .msi / .deb)
mise exec -- ./gradlew :composeApp:createDistributable

# Web (Kotlin/Wasm) production bundle -> composeApp/build/dist/wasmJs/productionExecutable
mise exec -- ./gradlew :composeApp:wasmJsBrowserDistribution

# Web development server with live reload
mise exec -- ./gradlew :composeApp:wasmJsBrowserDevelopmentRun

# Android Debug APK -> androidApp/build/outputs/apk/debug/androidApp-debug.apk
mise exec -- ./gradlew :androidApp:assembleDebug

# iOS Simulator & Device frameworks -> composeApp/build/bin/{iosSimulatorArm64,iosArm64}/debugFramework
mise exec -- ./gradlew :composeApp:linkDebugFrameworkIosSimulatorArm64 :composeApp:linkDebugFrameworkIosArm64

# Unit & live end-to-end integration tests
mise exec -- ./gradlew :composeApp:desktopTest
```

To serve the built KMP Web bundle directly from `deskfleet-server`:

```sh
DESKFLEET_WEB_DIRECTORY="$(pwd)/composeApp/build/dist/wasmJs/productionExecutable" \
  ../../target/debug/deskfleet-server
```
