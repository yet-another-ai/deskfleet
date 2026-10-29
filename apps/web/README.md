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
remain unavailable. Archiving a Session retains its history and working context;
restoring it does not start execution. There is no user-facing Session deletion.

Run shared UI and transport tests with
`mise exec -- pnpm --filter @deskfleet/desktop test`.
