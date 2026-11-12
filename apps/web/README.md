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
`dist/` into the native projects (`cap sync android` automatically builds and stages
the Rust Android viewer library via `capacitor:sync:before`):

```sh
mise run android:sync
mise run android:test
mise run android:build
```

On iOS, the audio-reactive outline uses the `BroadcastUpload` ReplayKit extension (`ai.yetanother.deskfleet.BroadcastUpload`). Both `App` and `BroadcastUpload` use the `group.ai.yetanother.deskfleet` App Group entitlement. Before you sign for a physical iOS device in Xcode, enable this App Group on both bundle identifiers. If the App Group is missing, the app reports the audio-reactive outline as unsupported.

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
