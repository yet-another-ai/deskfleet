# DeskFleet web

The Vue application uses the same pages, components,
conversation rendering, Git panels, terminal surfaces, and settings as Electron.
`packages/components` owns that UI; `packages/client` owns the injected platform
interfaces and the HTTPS/WebSocket adapter. The official server image bundles
this application and serves its static files from the same Actix process as the API.

From the repository root:

```sh
mise -E development run dev
mise exec -- pnpm --filter @deskfleet/web typecheck
mise exec -- pnpm --filter @deskfleet/web build
```

The `dev` task runs both the API and Web client. Use `mise run web:dev` when the
API is already running separately. Electron also uses this Web service for login.

Open Vite at `http://localhost:5174` (its listener binds to loopback). The
development API defaults to `http://localhost:8080`. WebAuthn requires a DNS
hostname, including localhost for development. Set `VITE_DESKFLEET_SERVER_URL` at build time for a
separately hosted API; production otherwise uses the page's origin.

For the official image, leave `VITE_DESKFLEET_SERVER_URL` unset when building Web
and set `DESKFLEET_PUBLIC_URL` and `DESKFLEET_AUTH_WEB_URL` to the same public HTTPS
origin at runtime. The image sets `DESKFLEET_WEB_DIRECTORY=/usr/share/deskfleet/web`.
For a binary deployment, set that variable to the absolute path of the built
`dist/` directory. The server serves `/` and `/auth/*` through `index.html`,
serves static files, and preserves 404 responses for missing API routes and assets.

Independent static hosting remains supported: deploy `dist/` on a static host
with an `index.html` fallback for `/auth/*`, configure `DESKFLEET_AUTH_WEB_URL`,
and allow the Web origin in `DESKFLEET_WEB_ORIGINS` when it differs from the API
origin. Web and API must share a site for SameSite cookies; unrelated cross-site
hosting is unsupported.

## Progressive Web App

The Web client is an installable, online PWA. Supporting browsers use
`public/manifest.webmanifest` to install DeskFleet with its own icon and launch
`/` in a standalone window. The stable app ID and scope are `/`, so each hosted
origin has its own installation. Deploy the entire `dist/` directory at the
origin root, including the manifest and icons. The bundled server already serves
these files; an independent static host should serve `.webmanifest` as
`application/manifest+json` and revalidate it when checking for updates.

Installation requires HTTPS in production; `localhost` and `127.0.0.1` work for
local development. Use the browser's Install app command, or Add to Home Screen
on iOS. Availability and wording depend on the browser. See the
[browser installation requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

This configuration does not register a service worker. Login, synchronized
history, and live operations retain their existing network requirements;
installation adds neither offline access nor notifications after the app closes.
New frontend builds load on normal navigation or reload without a service-worker
cache or a forced refresh of active sessions.

The 192px and 512px installation icons, the existing Apple touch icon, and the
Capacitor iOS and Android app icons come from the shared brand artwork. Regenerate
them with `mise exec -- pnpm --filter @deskfleet/desktop icons`.
After `mise run web:build`, check the manifest and icon previews in browser
DevTools under Application → Manifest on an HTTPS or localhost deployment.

## Capacitor (iOS & Android)

`@deskfleet/web` also manages the Capacitor iOS and Android projects under `ios/`
and `android/` with app ID `ai.yetanother.deskfleet`. [`capacitor.config.ts`](capacitor.config.ts)
reads `CAPACITOR_DEV_SERVER_URL` so [`@proj-airi/cap-vite`](https://www.npmjs.com/package/@proj-airi/cap-vite)
can start the Vite dev server and launch Capacitor live reload in one command:

```sh
mise run web:dev:ios
mise run web:dev:android
# Or select a specific device/simulator via environment variable or arguments:
CAPACITOR_DEVICE_ID_IOS="<DEVICE_ID_OR_SIMULATOR_NAME>" mise run web:dev:ios
CAPACITOR_DEVICE_ID_ANDROID="<DEVICE_ID_OR_EMULATOR_NAME>" mise run web:dev:android
```

For a bundled native build without the dev server, build the Web client and sync
`dist/` into the native projects (`cap sync android` and `cap sync ios` automatically
build and stage the Rust viewer library and XCFramework via `capacitor:sync:before`):

```sh
mise run ios:sync
mise run ios:test
mise run ios:build
mise run android:sync
mise run android:test
mise run android:build
```

### Workspace Agent iOS development build

Run these commands from the repository root. The standard App ID is
`ai.yetanother.deskfleet`. The development build uses a separate identity for
its app, ReplayKit extension, and App Group. It uses the registered native
authentication callback and the same DeskFleet service.

```sh
export DESKFLEET_IOS_APP_ID=com.example.deskfleet.workspaceagent
export DESKFLEET_IOS_DISPLAY_NAME="DeskFleet Workspace"
export VITE_DESKFLEET_SERVER_URL=https://deskfleet.yetanother.ai
mise run ios:sync
```

After a successful full sync, reuse the staged Rust viewer XCFramework and
Swift packages when rebuilding a Vue-only change. Run the full sync again
when the Rust viewer or native plugins change.

```sh
pnpm --filter @deskfleet/web build
pnpm --filter @deskfleet/web exec cap copy ios
```

The existing session list opens by default. Switch on **Settings → Preferences → Enable Super Agent** to use project conversations on this device. You can organize history on the selected machine from the same settings page.

On iOS, **Settings → Appearance → Text size** adjusts interface text from 85% to 150%
and saves the selection on the device. Choose 100% to restore the default.

Use the same ID and display name in Xcode. The SwiftPM lock is checked strictly:
Firebase 13.2.0 requires GoogleAppMeasurement 13.2.x, App Check 12.x, and newer
gRPC and Abseil than the earlier lockfile specified. GoogleAppMeasurement
13.2.x requires Google Ads On Device Conversion 3.8.x. GTMSessionFetcher stays
on the compatible 4.5.0 pin.

```sh
build_workspace_ios() {
  xcodebuild -project apps/web/ios/App/App.xcodeproj -scheme App -configuration Debug \
    -onlyUsePackageVersionsFromResolvedFile \
    -clonedSourcePackagesDirPath "$PWD/target/ios-swift-packages" \
    DESKFLEET_IOS_APP_ID="$DESKFLEET_IOS_APP_ID" \
    DESKFLEET_IOS_DISPLAY_NAME="$DESKFLEET_IOS_DISPLAY_NAME" "$@" build
}

# Apple Silicon simulator; the Rust viewer provides an arm64 simulator slice.
build_workspace_ios -destination 'generic/platform=iOS Simulator' ARCHS=arm64 \
  -derivedDataPath "$PWD/target/ios-simulator" CODE_SIGNING_ALLOWED=NO
```

For a physical iPhone, set `DESKFLEET_DEVELOPMENT_TEAM` to your Apple
development Team ID. Register the same `group.<app identifier>` App Group
for the app and its `.BroadcastUpload` extension. Xcode can then sign both
targets and enable the audio-reactive outline.

```sh
build_workspace_ios -destination 'generic/platform=iOS' \
  -derivedDataPath "$PWD/target/ios-device" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="${DESKFLEET_DEVELOPMENT_TEAM:?Set your Apple development team ID}"
```

For independent development profiles without the App Group and Push Notifications
capabilities, point both targets at an explicit empty entitlements file. With
Xcode 26 a blank build setting can still pick up the upstream push capability.
This local signing variant supports workspace conversations and dictation. APNs
delivery and the audio-reactive outline require matching entitlements and, for
push, a backend configured for the independent app's APNs topic.

```sh
mkdir -p "$PWD/target"
empty_entitlements="$PWD/target/ios-local-empty.entitlements"
plutil -create xml1 -- "$empty_entitlements"
build_workspace_ios -destination 'generic/platform=iOS' \
  -derivedDataPath "$PWD/target/ios-device" \
  DEVELOPMENT_TEAM="${DESKFLEET_DEVELOPMENT_TEAM:?Set your Apple development team ID}" \
  DESKFLEET_OUTLINE_AUDIO_GROUP= CODE_SIGN_ENTITLEMENTS="$empty_entitlements"
```

The simulator app is in `target/ios-simulator/Build/Products/Debug-iphonesimulator/App.app`.
To install the signed device app on a paired iPhone, set `DESKFLEET_IPHONE` to
its name or UDID:

```sh
xcrun devicectl device install app --device "$DESKFLEET_IPHONE" \
  target/ios-device/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device "$DESKFLEET_IPHONE" "$DESKFLEET_IOS_APP_ID"
```

### Mobile push notifications

The native apps use `@capacitor/push-notifications` with APNs on iOS and FCM on
Android. The `mobile_push_notifications` Statsig gate controls onboarding,
settings, and token registration. Build with `VITE_STATSIG_CLIENT_KEY` and
enable the gate for the intended users in the build's Statsig environment.
Gate evaluation requires both site telemetry and user consent. See [analytics setup](../../agents/docs/analytics.md#privacy-gates-site-master-switch-and-user-opt-in-consent).

When the gate is on, device notification permission is granted, and the user
is signed in, the client registers its push token, locale, and notification
preferences (`enabled`, `taskCompleted`, `taskNeedsInput`) with
`PUT /api/push/subscription`. Tapping a notification opens the target Session.

For iOS, follow the [App ID and signing setup](../../agents/docs/ci.md#ios-distribution-signing-and-testflight).
For Android, place the Firebase `google-services.json` for
`ai.yetanother.deskfleet` in `apps/web/android/app/`. Release CI stages it from
the `ANDROID_GOOGLE_SERVICES_JSON` secret. Builds without the file skip the
Google Services Gradle plugin. Configure the
[server push credentials](../server/README.md#mobile-push-notifications) for
the matching APNs environment or Firebase project.

## Backend and integrations

The welcome page signs in to this compiled backend and has no address setting.
Changing a compiled API origin requires rebuilding the Web client. A production
build without an API override follows the origin serving its page.

Statsig behavioral events and UI experiments are optional. Set
`VITE_STATSIG_CLIENT_KEY` to a Statsig **client-public** SDK key before running
Vite or building the Web app. Never use a server secret key: Vite includes this
value in the public bundle. An unset or blank key disables Statsig.
`VITE_STATSIG_ENVIRONMENT` optionally selects the Statsig environment; it defaults
to Vite's mode (`development` or `production`). Vite reads `.env` files from
`apps/web/`, including mode-specific files, with process environment values taking
precedence. Changing these values requires a rebuild.

When Statsig is enabled, a hosting Content Security Policy must allow
`https://featureassets.org`, `https://prodregistryv2.org`, and
`https://statsigapi.net` in `connect-src`. The shared client owns event logging
and feature/experiment evaluation. Experiments may change the frontend experience;
authorization, subscription entitlements, and quotas remain enforced by the
server and daemon. See the [analytics guide](../../agents/docs/analytics.md) for
identity, event metadata, and the shared API.

Sentry error reporting is independently optional. Set `VITE_SENTRY_DSN` to a
public Sentry DSN before development or building; missing, blank, or invalid
values disable reporting. `VITE_SENTRY_ENVIRONMENT` defaults to Vite's mode.
These values use the same environment-file location and rebuild rules as Statsig.
Tagged builds automatically use the same Sentry release as Electron, such as
`deskfleet@v0.2.1`. Allow the DSN's origin in the Web host's `connect-src` policy.
See the
[error-reporting guide](../../agents/docs/error-reporting.md) for scope and data
collection.

Register and verify your email, or sign in using your password or Passkey.
Select a team and a machine, and
use its synchronized resource catalog. An administrator can create a team,
manage members, generate an invitation code, and enroll a headless machine.
The enrollment dialog accepts the identity reported by `deskfleet-daemon status`
and displays a credential for import through the daemon's enrollment command.
That credential is displayed only in the dialog and is not saved by the client.

The browser uses HttpOnly login cookies, CSRF headers on mutations, and Origin
validation for WebSockets. The backend address comes only from build configuration;
it is not retained as a browser preference.
Email links open verification/recovery pages; `/auth/account` manages credentials
and login sessions. Electron keeps an encrypted application token in its main
process and uses the system browser with a one-use code/verifier exchange.

Authentication pages read mailed `#token=...` fragments before removing them from
browser history. Their shared components must not initialize the application's
hash router, which would rewrite those fragments. Account-context consumers on
these pages use `account-session-context.ts`, independent of session creation
and routing.

The Team menu opens `/team/settings`, independently of application settings at
`/settings`. Its Plans & Usages section at `/team/settings/plans` shows the
effective plan, current usage, monthly/annual Checkout offers when payments are
configured, and an optional Enterprise Contact us mailbox when
`DESKFLEET_ENTERPRISE_CONTACT_EMAIL` is set. Both areas remain available without
an enrolled machine. Only Team admins can purchase or manage subscriptions. Site
admins manage Enterprise overrides and account policies in the Web administration
page.

Management operations use authenticated HTTP. Agent commands, terminal I/O, and
Git reads use WebRTC after the backend authorizes the target peer and supplies
STUN/TURN configuration. Signaling loss alone leaves an established peer running;
revocation or authorization expiry closes it. Reconnecting creates a new grant.
Machine selection replaces the target's application scope, so equal local IDs
from different daemon databases cannot share cached state.

The file transfer queue lives outside that selected-machine scope. Its local
pane requires explicit browser directory access and uses OPFS staging; it lasts
only while the page remains open. Agent file/image references use the executing
machine's files peer. See [files and transfers](../../agents/docs/files.md) for
browser support, destination commit limits, and conflict behavior.

When a machine is offline, the application reads synchronized conversation
history from the backend, including its completeness watermark. Live operations
remain unavailable. Archiving a Session retains its history and removes generated
checkouts, including uncommitted and untracked files. Restoring recreates checkouts
at their saved committed HEADs without starting execution. Directory Sessions
leave source files untouched. The archived Sessions page offers Delete with hold
confirmation to remove local Session records and owned resources.

Run shared UI and transport tests with
`mise exec -- pnpm --filter @deskfleet/desktop test`.
