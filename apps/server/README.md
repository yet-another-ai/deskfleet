# DeskFleet server

An Actix Web control plane backed by PostgreSQL. It owns verified accounts and credentials,
application sessions, Teams and roles, machine enrollment, management RPC routing,
trusted WebRTC signaling, and read replicas of daemon catalogs and Agent journals.
The Vue Web frontend and Electron use the same API. The official server image
includes the Web build and serves it from the same process; independent Web
hosting remains supported.
Execution, provider processes, files, PTYs, and terminal output stay on the daemon.
See the [backend scope](../../agents/docs/backend.md) and
[WebRTC authorization](../../agents/docs/webrtc-security.md).
For the official v0.1.0 trial, use the
[hosted deployment checklist](../../agents/docs/hosted-deployment.md) for service
provisioning, runtime/build secrets, and public smoke acceptance.

## Run and configure

For local development, Docker Compose supplies PostgreSQL, Valkey, and coturn.
Authentication emails are written to the local `.local/mail/` directory. From the repository root:

```sh
mise run infra:up
mise -E development run dev
```

See the [development environment](../../agents/docs/environment.md#local-docker-compose)
for mailbox verification, Web/Electron startup, isolated test databases, and cleanup.

For your own services, use PostgreSQL 17 or later and the locked toolchain:

```sh
DATABASE_URL='postgres://deskfleet:password@127.0.0.1:5432/deskfleet' \
DESKFLEET_AUTH_WEB_URL='https://app.example.com' \
DESKFLEET_SMTP_HOST='smtp.example.com' \
DESKFLEET_SMTP_USERNAME='mailer' \
DESKFLEET_SMTP_PASSWORD='from-your-secret-store' \
DESKFLEET_MAIL_FROM='deskfleet@example.com' \
DESKFLEET_PUBLIC_URL='https://api.example.com' \
DESKFLEET_WEB_ORIGINS='https://app.example.com' \
mise exec -- cargo run -p deskfleet-server --locked
```

The Web origin serves `/auth/*` through the SPA entry point. Build split-origin
Web deployments with `VITE_DESKFLEET_SERVER_URL=https://api.example.com`.
Use HTTPS and origins on the same site for the browser's SameSite=Lax cookies;
unrelated cross-site Web/API hosting is unsupported. SMTP uses mandatory STARTTLS
(default port 587). The local mail-file sink is available only on localhost.

Electron opens the system browser at the trusted Web origin. Approval returns a
60-second one-use `#loginCode` to `http://127.0.0.1:<port>/auth/callback`; the
main process exchanges it with its private verifier. Other callback hosts,
paths, queries and credentials are rejected.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL. SQLite is rejected. |
| `DESKFLEET_BIND_ADDR` | One or more comma-separated IP:port addresses; defaults to `127.0.0.1:8080`. IPv6 addresses require brackets. |
| `DESKFLEET_WEB_DIRECTORY` | Optional directory containing the built Web `index.html` and assets. Unset keeps the binary API-only. The image sets `/usr/share/deskfleet/web`. |
| `DESKFLEET_PUBLIC_URL` | Stable external API origin and server identity; defaults to `http://localhost:8080`. |
| `DESKFLEET_TRUSTED_PROXY_IPS` | Comma-separated exact proxy IPs allowed to set `X-Real-IP` for authentication rate limits. Empty by default; proxies must overwrite that header. |
| `DESKFLEET_AUTH_WEB_URL` | Trusted Web origin for verification links, Passkeys, and desktop authorization. Defaults to the first Web origin or API origin. |
| `DESKFLEET_WEBAUTHN_RP_ID` | Passkey relying-party ID; defaults to the Web hostname. Keep it stable. |
| `DESKFLEET_SMTP_HOST`, `DESKFLEET_SMTP_PORT` | STARTTLS mail relay and optional port (587). Required outside local development. |
| `DESKFLEET_SMTP_USERNAME`, `DESKFLEET_SMTP_PASSWORD`, `DESKFLEET_MAIL_FROM` | Mail relay credentials and sender. |
| `DESKFLEET_MAIL_DIRECTORY` | Local-only mail sink; defaults to `.local/mail`. Messages contain one-use secrets and are ignored by Git. |
| `DESKFLEET_DEPLOYMENT_MODE` | `self-hosted` (default): unlimited allowances and no Stripe; or `hosted`. |
| `DESKFLEET_STATSIG_SERVER_KEY` | Optional Statsig server secret for verified billing events. Unset disables event production and delivery. Never expose it through a frontend `VITE_*` variable. |
| `DESKFLEET_STATSIG_ENVIRONMENT` | Statsig environment tier, default `production`; match the frontend project and tier. See [analytics](../../agents/docs/analytics.md#payment-funnel). |
| `DESKFLEET_WEB_ORIGINS` | Comma-separated browser origins permitted by CORS. |
| `DESKFLEET_STUN_URLS` | Optional comma-separated `stun:`/`stuns:` URLs advertised on peer grants. Empty means no STUN; there is no public default. Change the list and restart to update new grants. |
| `DESKFLEET_TURN_URLS` | Optional comma-separated `turn:`/`turns:` URLs advertised on peer grants. Change the list and restart to update new grants. |
| `DESKFLEET_TURN_SECRET` | Required with TURN URLs; shared with coturn's REST credential mechanism. |
| `DESKFLEET_TURN_USAGE_REDIS_URL` | Optional `redis://` or `rediss://` URL for [Team TURN usage collection](../../agents/docs/self-hosted.md#team-turn-usage-collection). Empty or unset disables it. |
| `RUST_LOG` | Log filter; defaults to `info`. |

To listen explicitly on both IPv4 and IPv6, set:

```dotenv
DESKFLEET_BIND_ADDR=0.0.0.0:8080,[::]:8080
```

The list also supports different addresses and ports. Surrounding whitespace is
ignored, but empty entries and invalid addresses fail configuration. Every
configured address must bind successfully before the HTTP server starts; a
failure aborts startup instead of serving only part of the list. All listeners
serve the same API and Web routes with shared application state.

When an IPv4 address is listed on the same port, the IPv6 wildcard socket accepts
only IPv6, so the two listeners do not conflict. This explicit pair does not depend
on the operating system's IPv4-mapped IPv6 default. A single `[::]:8080` keeps
the existing platform-dependent behavior.

For official hosting, run server instances behind a TLS reverse proxy that
supports WebSocket upgrades, request bodies of at least 64 MiB, and idle periods
longer than the 60-second socket timeout. With the official image, forward all
paths to the server and set the public API and authentication Web origins to
the same HTTPS origin.
Store PostgreSQL data on persistent storage and supply database/SMTP/TURN secrets via
the deployment's secret mechanism. `DESKFLEET_PUBLIC_URL` must remain stable.
Instances share one PostgreSQL database, public origin, and service configuration.
PostgreSQL leases fence machine socket ownership; short-lived inboxes route
requests, replies, client events, and revocations across instances. SDP offers,
answers, and early ICE candidates are shared in PostgreSQL as well. The load
balancer does not need sticky sessions, and there are no additional routing
environment variables. Redis remains specific to TURN usage collection.

Database outages close signaling for reconnect instead of trusting stale local
routes. A process crash can interrupt an in-flight RPC; check the daemon's
operation receipt before retrying. Existing WebRTC grants keep their normal
bounded lifetime. See [multi-instance operation](../../agents/docs/self-hosted.md#what-this-release-runs).

`GET /healthz` reports process liveness and protocol version. Database migrations
and authentication configuration validation complete before the HTTP listener starts.
Database, migration, or invalid configuration failures stop startup. Actix handles graceful shutdown.

## Web static hosting

Set `DESKFLEET_WEB_DIRECTORY` to a built Web directory to serve it alongside the
API. For a local binary, use an absolute path such as `/opt/deskfleet/web`;
the official image sets this automatically. The directory must contain
`index.html`. The server serves the entry point at `/` and `/auth/*` so browser
login, recovery, Passkeys, and Electron authorization work on direct navigation.
Application navigation otherwise uses URL hashes. Static files are served from
the configured directory; missing assets and unknown `/api/*` routes retain
404 responses rather than returning the SPA page.

HTML entry points and fixed-name files such as favicons use
`Cache-Control: no-cache`, allowing browsers to store them but requiring
revalidation before reuse. Vite assets under `/assets/` whose filenames end in
an eight-character content hash use
`Cache-Control: public, max-age=31536000, immutable`. Their URLs change when their
contents change, so browsers can reuse them for one year without revalidation.
Both policies apply to `GET`, `HEAD`, and conditional `304` responses; ETag and
Last-Modified validators remain available. Static-file errors use `no-store`,
including missing hashed assets. API and health routes retain their own policies.

The Web build uses its serving origin unless `VITE_DESKFLEET_SERVER_URL` was
set at build time. Leave that variable unset for the bundled image. Runtime
environment changes do not rewrite the bundle, including its optional Statsig
configuration. Leave `DESKFLEET_WEB_DIRECTORY` unset for a binary used with an
independent static host or Vite during local development.

## Container image

Version-tag builds publish `ghcr.io/yet-another-ai/deskfleet-server` for
`linux/amd64` and `linux/arm64`. The image contains the server binary and Web
build from the same release run. Web files live at `/usr/share/deskfleet/web`
and are served by the single Actix process. It runs as UID/GID `10001:10001`
and listens on `0.0.0.0:8080` inside the container.

Put the configuration above in an environment file, including `DATABASE_URL`,
the public API/Web origins, and SMTP settings. Use a database hostname reachable from
the container; `127.0.0.1` inside it refers to the server container itself.
For example, behind a reverse proxy on the same host:

```sh
docker run --detach --name deskfleet-server \
  --env-file /path/to/deskfleet-server.env \
  --publish 127.0.0.1:8080:8080 \
  ghcr.io/yet-another-ai/deskfleet-server:0.1.0
```

TLS termination, PostgreSQL, SMTP, coturn, and Redis remain separate services;
PostgreSQL needs persistent storage. The image needs no application data volume.
Use `/healthz` for the deployment's HTTP liveness probe, and allow at least
15 seconds for graceful shutdown.

`apps/server/Dockerfile` packages already-built Linux binaries and Web files.
Its build context contains `amd64/deskfleet-server` and/or
`arm64/deskfleet-server`, plus `web/` containing `apps/web/dist/`; the target
platform selects the binary and both architectures share the Web build.
After `mise run build` on a Linux build host, for example:

```sh
mkdir -p dist/server-image/arm64 dist/server-image/web
host_target=$(mise exec -- rustc --print host-tuple)
cp "target/$host_target/release/deskfleet-server" dist/server-image/arm64/
cp -R apps/web/dist/. dist/server-image/web/
docker build --platform linux/arm64 -f apps/server/Dockerfile \
  --tag deskfleet-server:local dist/server-image
mise exec -- node scripts/smoke-server-image.ts deskfleet-server:local
```

Use `amd64` for a Linux x64 binary. The smoke script starts an isolated,
temporary PostgreSQL container, verifies non-root server startup, migrations,
HTTP health, the Web entry point and assets, authentication-page fallback,
cache policies and conditional requests, missing API/asset responses, and
signal-driven shutdown, then removes its
containers and network.

## Authentication and API

### Site administration

For the local Compose development stack, `mise run dev:seed` creates the verified
Site Admin `admin@deskfleet.test` with password `deskfleet-dev-password`.
This explicit debug-build command requires no mail delivery and leaves existing
accounts unchanged. It creates no Team and is never run during normal startup.

Site administrators use the same password/Passkey login as other users. Their grants are
independent of Team roles and do not allow access to other Teams' machines,
history, terminals, or Agent sessions. No user becomes a site administrator
automatically. First log in, obtain the account's `user.id` from `GET /api/me`,
then run an operations command with access to the server database:

```sh
mise exec -- cargo run -p deskfleet-server --locked -- site-admin grant <user-id>
mise exec -- cargo run -p deskfleet-server --locked -- site-admin list
mise exec -- cargo run -p deskfleet-server --locked -- site-admin revoke <user-id>
```

These commands require `DATABASE_URL`; they do not start HTTP or send mail. Packaged deployments can run `deskfleet-server site-admin ...`
directly. The UUID must identify an existing user. Grant/revoke are idempotent,
and the same grant command can recover access after the final grant is revoked.
The CLI records its source as `cli`, without attributing the operation to an
interactive user.

`GET /api/me` returns the current `siteAdmin` flag. Administrators can open
**Site administration** from the Web client's account menu, including when they
have no Team. The administration UI is Web-only.
`GET /api/site` publicly returns `siteName`, `announcement`, `allowTeamCreation`,
`termsOfServiceUrl`, and `privacyTermsUrl`. The defaults are `DeskFleet`, an empty
announcement, `true`, and two empty URLs. Web and Electron display the name/announcement and honor the creation
switch. Closing Team creation applies to all users, including site administrators;
existing Teams and invitation acceptance are unaffected.
The brand-name migration updates the original `deskfleet` site name to
`DeskFleet` once; other configured names are preserved.

`GET /api/admin/site-settings` and `PATCH /api/admin/site-settings` require the
current site grant. PATCH accepts all five settings fields, rejects unknown
fields, and returns the saved settings. Names are trimmed and must contain
1–200 UTF-8 bytes; announcements allow up to 10,000 UTF-8 bytes. Legal URLs are
trimmed and must be empty or absolute HTTP/HTTPS URLs without credentials.
Configure either or both links in Site administration; leave both empty to omit
the registration agreement. Configuration
and grant/revoke changes write `cp_site_audit` in the same transaction, recording
source, actor or target user, time, and previous/new values. Subsequent requests
read updated settings and grants without restarting the backend or logging in
again. Deployment secrets and startup options remain environment configuration.

### Application and machine authentication

Web uses Secure HttpOnly opaque session cookies, exact Origin checks and a
CSRF cookie/header on mutations. Fetch `/api/auth/config` for a CSRF token and
send it as `X-CSRF-Token` with credentials included. Native clients and machines
use `Authorization: Bearer <opaque token>`. PostgreSQL stores token hashes.
Application sessions last 30 days; machine credentials remain valid until
administrator revocation.

Registration first sends a one-hour mailbox-verification link. The mailbox owner
chooses the password on verification; no unverified password is later attached
to their account. Passwords use bounded, off-executor Argon2id hashing, 15–128
characters, and screening of common values. Address matching trims whitespace
and case-folds ASCII email without removing plus tags. Recovery links are
purpose-bound, one-use, and expire after one hour. Recovery and password/email
changes revoke all login sessions and peer grants without deleting Machines or
stopping accepted execution. Ordinary recovery retains Passkeys. Security
changes require a password or Passkey confirmation within ten minutes.

`GET /api/auth/config` exposes the current `termsOfServiceUrl` and
`privacyTermsUrl`. When either is configured, registration displays an unchecked
agreement checkbox linking to the configured documents. `POST /api/auth/register`
requires `acceptedTerms: true` before issuing a verification challenge or sending
mail; missing or false consent returns `terms_acceptance_required`. With both URLs
empty, the existing email-only request remains valid. Resending a registration
link includes the same acceptance; password recovery is unaffected.

Public registration is a separate persisted policy (`PATCH /api/auth/registration`),
independent of Team creation. Site administrators can search accounts through
`GET /api/admin/users?query=` and disable them with
`PATCH /api/admin/users/{id}/disabled`. Disablement blocks login and later
delegated authorization; changing these policies requires recent authentication.

Machine removal leaves Team membership intact. A removed installation must
prepare a fresh empty data directory and origin before enrolling again, including
when returning to the same Team; the old machine's credentials and origin cannot
be reused. Old replicas stay scoped to the removed central machine ID.

The `/api` routes cover:

- `/auth/config`, `/auth/register`, `/auth/verify`, `/auth/login`, recovery,
  password/email changes, Passkey management, login-session inspection/revocation.
- `/auth/start`, `/auth/desktop/complete`, `/auth/exchange`, `/auth/logout`, `/me`.
- `/teams`, membership/role management, invitations, and `/invites/accept`.
- Team machine enrollment/listing, renaming (`PATCH /machines/{id}`), and
  administrator machine removal.
- `/machines/{id}/rpc` for an explicit management-method allowlist, including
  Session create, archive, restore, configuration, and operation receipt lookup.
- Machine catalog, Session snapshots, paginated events, and command audit reads.
- `/daemon/me`, `/daemon/catalog`, and `/daemon/history` with machine credentials.
- `/peers` creation, immutable offer/answer exchange, ICE candidate forwarding,
  desktop stream start, and revocation.

Admins manage members/roles and remove machines. All members can enroll their
machines, rename team machines, and operate resources on them. A machine's Team
name is chosen at enrollment, where clients default it to the daemon's hostname.
Catalog reads report that name as `snapshot.machineName` in place of the
daemon-reported hostname, and a rename notifies the Team with `catalogChanged`.
No route exposes permanent
Session deletion. Archive snapshots and Agent command receipts remain available
when a machine is offline; terminal output is never uploaded.

History ingestion writes a snapshot, event page, and command snapshot atomically.
The acknowledged `lastEventSeq` is the contiguous persisted event cursor, while
`snapshot.session.lastEventSeq` can be ahead during initial synchronization.
Repeated event pages are idempotent; conflicting content or gaps are rejected.
Older snapshots cannot overwrite newer snapshots or command receipts. Session lists and command audits use `after` decimal ID cursors and `limit`
(default 200, maximum 1000), returning `{sessions,nextCursor?}` or
`{commands,nextCursor?}`. Session lists also accept `archiveState` with `all`,
`active`, `archiving`, or `archived`. Resource
IDs remain daemon-local inside payloads and are scoped by the central machine ID.

Clients and daemons connect to `/api/client/ws` and `/api/daemon/ws`. Their first
message is `{ "type": "authenticate", "token": "..." }`; tokens never appear in
URLs. A daemon reconnect receives all still-valid peer grants for reconciliation.
The same reconciliation runs on its 20-second heartbeat, repairing a lost
revocation broadcast at the next successful database read and signaling delivery
while retaining active peers.
WS authentication/access failures close with 4401/4403; transient routing replacement
uses 1012. Explicit revocation has an independent shutdown path if outbound queues
are full. Transport loss alone preserves existing WebRTC peers until their fixed
24-hour deadline; it never stops tasks or shells.

TURN credentials use expiring coturn REST usernames and HMAC-SHA1 passwords. The
trusted center binds each exact SDP exchange and ICE generation to one actor,
Team, target machine, and purpose. The WebRTC stacks perform certificate fingerprint
verification during DTLS. Failed negotiation requires a new peer authorization.

The backend also supports optional
[Team TURN usage collection](../../agents/docs/self-hosted.md#team-turn-usage-collection)
through Redis; the deployment guide covers setup and collection limits.

The Rust wire source is `crates/protocol/src/control.rs`; its generated type-only
bindings are `crates/protocol/control.ts`:

```sh
mise exec -- cargo run -p deskfleet-protocol --example export_types -- --check
```

## Database migrations

The central `deskfleet-control-store` crate has a separate PostgreSQL `cp_*`
schema. It does not reuse or import daemon SQLite tables. Startup applies explicit
numbered SQL under a transaction and advisory lock; schema versions are tracked
in `cp_migrations`. Back up PostgreSQL before schema changes. The central migration
example supports `up`, `status`, and `down`; `down` drops central tables
and their data. The daemon's `db:migrate` task manages a different SQLite database.

```sh
mise exec -- cargo run -p deskfleet-control-store --example migrate -- status
```

## Verification

Unit tests run without external services. Integration tests require PostgreSQL;
TURN collection integration tests also require Valkey.
Each run creates uniquely scoped fixture identities.

```sh
mise exec -- cargo test -p deskfleet-protocol -p deskfleet-server -p deskfleet-control-store --locked
TEST_DATABASE_URL='postgres://postgres:password@127.0.0.1:5432/deskfleet_test' \
TEST_REDIS_URL='redis://127.0.0.1:6379/' \
  mise exec -- cargo test -p deskfleet-control-store -p deskfleet-server --locked -- --ignored
```

The backend smoke script additionally exercises mailbox verification and password/native exchange APIs, the live
HTTP/WebSocket server, daemon synchronization, and actual WebRTC data channels.
