# Self-hosted backend

This guide is the production deployment of DeskFleet's central server. It covers
the `deskfleet-server` process, PostgreSQL, an SMTP relay, a TLS reverse
proxy, an optional TURN relay, and bundled or independent Web hosting.
For hosted plan enforcement and the official v0.1.0 trial, see the
[hosted deployment checklist](hosted-deployment.md).

The [server guide](../../apps/server/README.md) owns the HTTP API and local
configuration. The [development environment](environment.md#local-docker-compose)
owns the loopback Compose stack. That stack is not a production layout: every
published port binds to `127.0.0.1`, the passwords are public development
credentials, and the API process is not one of the containers.

## What this release runs

One or more `deskfleet-server` processes speak plain HTTP behind the same
reverse proxy or load balancer. Each process owns its WebSockets. PostgreSQL
shares machine-route ownership, cross-instance requests/responses, client events,
revocations, and SDP negotiation state. HTTP requests and WebSockets do not need
to reach the same instance; sticky sessions are not required.

Use the same read-write `DATABASE_URL`, stable `DESKFLEET_PUBLIC_URL`, and
authentication, billing, and ICE configuration on every instance. Each process
generates its own internal routing identity, so no replica-ID environment
variable or additional broker is needed. PostgreSQL process leases expire after
30 seconds; expired owners are no longer advertised as online. A replacement
daemon connection fences the previous socket's responses and cleanup.

Routing messages expire after 120 seconds and are consumed at most once. An API
crash can interrupt a pending RPC even after the daemon accepted its command;
inspect the operation receipt before retrying. PostgreSQL outages stop routing
and close signaling sockets for reconnect. They do not revoke established
WebRTC grants or stop agents and terminals on the daemon.

Daemon sockets reconcile peer grants from PostgreSQL every 20 seconds. A
revocation whose broadcast was lost is applied at the next successful
reconciliation; active grants are retained. This recovery requires a working
database and signaling connection. Reconnecting daemons also receive a fresh
reconciliation at connection setup.

The official image serves the Vue application from the same process as the API.
For a binary deployment, `DESKFLEET_WEB_DIRECTORY` enables static hosting;
without it the process serves only the API. TLS terminates at the reverse proxy.
Workspace files and agent execution stay on enrolled machines. The API authorizes
management calls and WebRTC signaling, then stores account data and replicas of
catalogs and Agent history.

PostgreSQL holds the central records; optional Redis carries TURN usage
notifications. There is no object store. The tables are the `cp_*` schema created
in the connection's search path (normally `public`). Startup applies them before
the listener opens.

| Durable central records | Machine-owned execution data |
| --- | --- |
| Verified user profiles, password hashes, and Passkey public credentials | Agent CLI credential files |
| Login-session, machine, invitation, and exchange-token hashes | Plaintext machine credential (`central.json`) |
| Teams, roles, and invitations | Workspace files, Git worktrees, and terminal transcripts |
| Machine enrollment, catalog snapshot, and display metadata for providers | Provider executable paths and environment configuration |
| Agent session snapshots, event pages, and command audit | Desktop media |

Synchronized provider rows keep id, template, name, and icon. Template rows keep
id and name. These catalog rows omit binary paths and environment values.
Cross-instance management RPCs still carry operation parameters and results,
including provider environment values, through `cp_realtime_messages`. Those
payloads have a 120-second expiry and are deleted on consumption or periodic
expiry cleanup; the router does not log them. Database snapshots and backups can
retain those payloads beyond their live-table lifetime and must be treated as
containing sensitive operation data.

Terminal output is never uploaded. A central backup cannot reconstruct a
machine's complete working directories, shells, or provider configuration.

`GET /healthz` is unauthenticated process liveness. The JSON body is
`status` (`ok`), `version` (the server package version), and
`protocol_version` (currently `1`, snake_case). It does not query PostgreSQL.
Migrations and authentication configuration validation have already succeeded if the process is
listening; a later database outage leaves `/healthz` green while API calls fail.

`PROTOCOL_VERSION` is still provisional. Contracts evolve in place at version
`1` until maintainers declare a freeze.

## Explicitly unsupported

- API instances using different databases or public service identities for one
  installation.
- A production Compose file. `compose.yaml` is the local development dependency
  stack only; the server container image is described in the server guide.
- TLS inside `deskfleet-server`. The listener is HTTP. The binary does not read
  `X-Forwarded-*` or a certificate path.
- Cross-site browser/API hosting on unrelated domains. Cookies use SameSite=Lax.
- An authentication bypass or automatic first-user administrator grant.
- SQLite, or any `DATABASE_URL` that does not start with `postgres://` or
  `postgresql://`.
- Permanent Session deletion. Archive and restore are the user-facing
  operations.
- Retargeting enrolled machines after `DESKFLEET_PUBLIC_URL` changes. The
  repository has no migration for that.
- Importing an old unauthenticated daemon directory into a team. Enrollment
  starts a new machine identity; `prepare-enrollment` keeps the old files in
  place and does not copy them.

## Prerequisites

- PostgreSQL 17 or later; development and CI currently use 18.6. The server
  does not probe the major version. The connected role needs to create and
  modify tables in its search path.
- An SMTP relay with STARTTLS and credentials, for verification and recovery mail.
- A TLS reverse proxy that can upgrade WebSockets, accept request bodies of at
  least 64 MiB, and keep a connection idle for more than 60 seconds.
- A TURN server that implements the REST credential mechanism, when peers
  cannot connect directly. STUN is optional.
- The official `deskfleet-server` image, which includes the Web client for browser
  use and Electron authentication, or the server binary and a separate Web build.
  Build the daemon and Electron for the computers that execute agents; they do
  not run on the API host.
- An accurate API host clock for session, challenge and entitlement deadlines.

Build the API from this repository. CI compiles the same server and daemon
binaries for Linux x64, Linux arm64, macOS arm64, and Windows x64, and the
Linux x64 job also uploads a Web client built without
`VITE_DESKFLEET_SERVER_URL` (that build calls the origin that serves the page).
Those uploads are workflow artifacts kept for 14 days. Version-tag builds also
publish a container image with the server and same-version Web build, plus draft
release archives. The Web build also remains available as a workflow artifact
for independent hosting. Neither workflow deploys the application. See
[tagged releases](ci.md#tagged-releases).

## Recommended layout

Put PostgreSQL and the server behind the proxy. Bind a host binary to loopback,
or publish the container's port only to the proxy's network. Browsers, Electron,
and daemons use the proxy's HTTPS origin. TURN, when you run it, is a separate
public UDP/TCP service; the API does not carry media.

```text
browsers, Electron, daemons
        |  HTTPS and WSS
        v
TLS reverse proxy
        |  all paths
        v
deskfleet-server instance(s)
        |-- /api and /healthz --> API handlers
        |-- / and /auth/*     --> Web index.html
        |-- static files     --> bundled Web directory
        |
        +--> PostgreSQL (read-write URL in DATABASE_URL)
        +--> outbound STARTTLS to the configured SMTP relay

browsers and daemons  --UDP/TCP-->  TURN listening port and relay range
```

Two public shapes work:

| Shape | API origin | Web origin | What to set |
| --- | --- | --- | --- |
| One hostname | `https://fleet.example.com` | same | Leave `VITE_DESKFLEET_SERVER_URL` unset. `DESKFLEET_WEB_ORIGINS` can stay empty. Set `DESKFLEET_AUTH_WEB_URL=https://fleet.example.com`. |
| Split hosts | `https://api.example.com` | `https://app.example.com` | Build the Web client with `VITE_DESKFLEET_SERVER_URL=https://api.example.com`. Set `DESKFLEET_WEB_ORIGINS=https://app.example.com` and `DESKFLEET_AUTH_WEB_URL=https://app.example.com`. |

Electron uses the built-in `127.0.0.1` loopback callback allowlist. The daemon's `--server-url` is the API origin, with no path.

The official image serves the one-hostname layout by default. Independent Web
hosting can use either shape: serve the Web files from a static host and route
API requests to the server. A binary with `DESKFLEET_WEB_DIRECTORY` unset remains
API-only, including during local development with Vite.

A process supervisor should restart the API on failure and inject the
environment from the host's secret store. The binary has no working-directory
requirement and does not need Node, mise, or a source checkout at runtime.
Stopping it with SIGINT or SIGTERM uses Actix Web's graceful shutdown. Daemons
reconnect and receive peer grants that are still valid in PostgreSQL.
Established WebRTC keeps working until revocation or the grant's original
24-hour deadline. Completed SDP answers are shared between instances. A crash
during an unfinished exchange can still require a new peer authorization.

## Build

From a checkout, with the locked toolchain:

```sh
mise install --locked
# Bake a split API origin into the Web client when it differs from the page.
# export VITE_DESKFLEET_SERVER_URL=https://api.example.com
mise run build
```

`mise run build` produces:

- `target/<host-triple>/release/deskfleet-server` (`.exe` on Windows; obtain the
  triple with `mise exec -- rustc --print host-tuple`)
- `apps/daemon/dist/deskfleet-daemon` (`.exe` on Windows)
- `apps/web/dist/` for the static Web client

To serve this Web build from a binary, set `DESKFLEET_WEB_DIRECTORY` to its
absolute directory path. The directory must contain `index.html`. The official
image copies these files to `/usr/share/deskfleet/web` and sets the variable for
you; it requires no Node runtime or additional Web server.

`VITE_DESKFLEET_SERVER_URL` is read when the Web or Electron client is compiled.
Changing a compiled API origin requires rebuilding the affected client. The UI has no
backend-address setting, and saved account data cannot override that choice.
Without the variable, production Web builds use the page's origin and Electron
uses `http://localhost:8080`. Build Electron for this deployment with:

```sh
VITE_DESKFLEET_SERVER_URL=https://api.example.com mise run desktop:build
```

A debug build (`mise run backend:dev` or `cargo build -p deskfleet-server`) is for
development. Production runs the release binary.

## Configuration reference

The process reads only these variables. Unknown names are ignored. Comma
separated lists are split on `,`, trimmed, and empty items dropped.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes |  | `postgres://` or `postgresql://` URL, including credentials, database name, and any driver options such as `sslmode`. Empty is rejected. Other schemes are rejected. There is no separate pool-size or database-TLS variable. |
| `DESKFLEET_BIND_ADDR` | no | `127.0.0.1:8080` | `IP:port` of the plain HTTP listener. A hostname is invalid. |
| `DESKFLEET_WEB_DIRECTORY` | no | unset for binaries; `/usr/share/deskfleet/web` in the image | Directory containing the built Web `index.html` and assets. Set an absolute path to enable Web hosting alongside the API. Unset keeps the binary API-only. |
| `DESKFLEET_PUBLIC_URL` | no | `http://localhost:8080` | External origin and the server identity (`serverId`). Use an `https` origin with no path and no trailing slash. The raw string is what daemons store. |
| `DESKFLEET_TRUSTED_PROXY_IPS` | behind a proxy | empty | Comma-separated exact proxy IPs allowed to supply `X-Real-IP` for authentication rate limits. |
| `DESKFLEET_AUTH_WEB_URL` | for split hosts | first Web origin or API origin | Trusted origin serving `/auth/*`, verification links and Passkeys. |
| `DESKFLEET_WEBAUTHN_RP_ID` | no | Web hostname | Stable Passkey relying-party ID. |
| `DESKFLEET_SMTP_HOST` | outside localhost | unset | Mandatory STARTTLS mail relay. |
| `DESKFLEET_SMTP_PORT` | no | 587 | SMTP submission port. |
| `DESKFLEET_SMTP_USERNAME`, `DESKFLEET_SMTP_PASSWORD`, `DESKFLEET_MAIL_FROM` | with SMTP | unset | Relay credentials and sender. |
| `DESKFLEET_MAIL_DIRECTORY` | local only | `.local/mail` | Development mail-file sink. |
| `DESKFLEET_DEPLOYMENT_MODE` | no | `self-hosted` | Self-hosted installations have unlimited allowances and no payment integration. |
| `DESKFLEET_WEB_ORIGINS` | for cross-origin browsers | empty | Comma-separated exact origins (`https://app.example.com`, with port if it is not the default). |
| `DESKFLEET_STUN_URLS` | no | empty | Comma-separated `stun:`/`stuns:` URLs advertised on peer grants. Invalid schemes fail startup. Empty means no STUN; DeskFleet does not ship a public STUN default. |
| `DESKFLEET_TURN_URLS` | no | empty | Comma-separated `turn:`/`turns:` URLs advertised on peer grants. Invalid schemes fail startup. Setting any URL requires a secret. |
| `DESKFLEET_TURN_SECRET` | with TURN URLs | unset | Shared with the TURN server's REST `static-auth-secret`. Empty is treated as missing and startup fails when TURN URLs are set. |
| `DESKFLEET_TURN_USAGE_REDIS_URL` | no | unset | `redis://` or `rediss://` URL for [Team TURN usage collection](#team-turn-usage-collection). Empty disables collection. Invalid URLs fail startup; unavailable Redis is retried in the background. |
| `RUST_LOG` | no | `info` | `tracing` `EnvFilter`. A missing or invalid value falls back to `info`. |

`DESKFLEET_PUBLIC_URL` is also the `serverId` in `/api/daemon/me`, the
WebSocket ready message, and peer grants. Keep it stable.

Startup validates origins, WebAuthn and SMTP configuration and applies
PostgreSQL migrations before binding HTTP. SMTP delivery failures are logged
without secrets; users can request a fresh verification or recovery link.

Example, with secrets supplied by the supervisor rather than a shell history:

```sh
DATABASE_URL='postgres://deskfleet:password@127.0.0.1:5432/deskfleet?sslmode=require' \
DESKFLEET_BIND_ADDR='127.0.0.1:8080' \
DESKFLEET_PUBLIC_URL='https://api.example.com' \
DESKFLEET_AUTH_WEB_URL='https://app.example.com' \
DESKFLEET_SMTP_HOST='smtp.example.com' \
DESKFLEET_SMTP_USERNAME='mailer' \
DESKFLEET_SMTP_PASSWORD='from-your-secret-store' \
DESKFLEET_MAIL_FROM='deskfleet@example.com' \
DESKFLEET_DEPLOYMENT_MODE='self-hosted' \
DESKFLEET_WEB_ORIGINS='https://app.example.com' \
DESKFLEET_STUN_URLS='stun:turn.example.com:3478' \
DESKFLEET_TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp' \
DESKFLEET_TURN_SECRET='shared-with-the-turn-server' \
deskfleet-server
```

`sslmode` in that URL is a PostgreSQL driver option on `DATABASE_URL`, not a
DeskFleet setting. Use the mode your database requires.

## Accounts and mail

The server owns verified email accounts, Argon2id passwords, Passkeys and opaque
30-day login sessions. Registration emails a one-hour verification link; the
mailbox owner chooses the first password after opening it. Recovery uses a
separate one-hour, one-use proof. User IDs remain stable when email changes.
Matching trims whitespace and lowercases ASCII email, preserving plus tags.

Browsers send HttpOnly session cookies. Mutations require the exact allowed
Origin and the CSRF token from `/api/auth/config` in `X-CSRF-Token`. WebSocket
upgrades using cookies also validate Origin. Use same-site HTTPS origins for
Web and API. The Web client's API origin comes from its build configuration;
browser storage cannot change it.

Electron opens the trusted Web authentication page in the system browser. An
explicit approval returns a 60-second code to a temporary
`http://127.0.0.1:<port>/auth/callback`; the main process exchanges its private
verifier and persists the resulting opaque token using platform secure storage.
The renderer never receives the token. Desktop attempts expire in ten minutes.

Password/email changes and recovery revoke login sessions and existing peer
grants atomically. They preserve Machine registration and accepted work.
Ordinary password recovery retains Passkeys. Adding/removing credentials and
changing security settings require recent password or Passkey authentication
within ten minutes. Site administrators can close public registration separately
from Team creation, search account metadata, and disable an account. Disablement
blocks later delegated work as well as current interactive access.

Team membership and Site Admin grants remain separate. The creator of a Team
is its administrator; other accounts join through invitations matching their
verified email. Operators explicitly grant Site Admin through the server CLI.

Local development writes `.eml` files to `.local/mail/`. Production requires
SMTP; neither SMTP credentials nor raw challenge tokens enter logs. A failed
send does not create an authenticated account, and another request sends a new
link. Retain mail delivery diagnostics when operating the service.

## Reverse proxy

For the bundled image or a binary with Web hosting enabled, proxy all paths to
`DESKFLEET_BIND_ADDR`. For independent Web hosting, proxy `/api` (HTTP and
WebSocket) and `/healthz` to the server and route Web requests to the static host.
WebSocket routes are `/api/client/ws` and `/api/daemon/ws`. Browser sockets authenticate from their cookie and Origin during the upgrade.
Native/daemon sockets send `{"type":"authenticate","token":"..."}` within ten
seconds. Tokens are not placed in the URL.

The server sends a WebSocket ping every 20 seconds and closes a socket that has
been silent for 60 seconds. The daemon sends its own application ping on the
same 20-second cadence and closes after 60 seconds without a message. Set the
proxy's read and idle timeouts above 60 seconds.

JSON bodies and WebSocket frames are limited to 64 MiB. Set the proxy's request
body limit to at least 64 MiB. History uploads use `POST /api/daemon/history`.

CORS allows `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`, and the headers
`authorization`, `content-type`, and `x-csrf-token`. Preflight caching is 3600
seconds. Cross-origin browser access requires the Web origin in
`DESKFLEET_WEB_ORIGINS`. Daemons and Electron's main process do not depend on
browser CORS permission. Same-origin Web hosting does not need its own origin
listed. There is no `*` origin. Credentialed CORS is enabled for the configured
origins.

Configure `DESKFLEET_TRUSTED_PROXY_IPS` with the proxy's actual TCP source IP
(`127.0.0.1` for the same-host example). The proxy must overwrite `X-Real-IP`
with the client address. Only these exact peers are trusted; all other forwarded
headers are ignored. This keeps authentication IP limits per client instead of
sharing one bucket across the proxy.

The proxy terminates TLS. `DESKFLEET_PUBLIC_URL` must be the `https` origin
clients use. The API will not reconstruct that origin from `Host` or
forwarded headers.

This nginx fragment illustrates those requirements. It is not shipped or tuned
as a DeskFleet component:

```nginx
# map belongs in the http context, outside the server block.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

For the bundled image, use the same all-path proxy block with the application's
hostname. The server serves `index.html` at `/` and `/auth/*`, preserving 404
responses for missing API routes and assets. Main application routes use hashes.

For independent static hosting on one hostname, serve `apps/web/dist` at `/`
and proxy only `/api` and `/healthz`. Authentication paths under `/auth/*` need
an `index.html` fallback; configure that fallback only for application pages,
so missing static assets still return 404.

## TURN and STUN

Direct WebRTC works when the browser or Electron client and the daemon can
reach each other. Advertise TURN when they cannot. The API issues a credential
per peer:

- Username: `{unix expiry seconds}:{peer id}`
- Password: standard Base64 of HMAC-SHA1(`DESKFLEET_TURN_SECRET`, username)

The expiry is the peer grant's expiry, 24 hours from authorization. Configure
the TURN server with the same shared secret and its REST long-term credential
mode (`use-auth-secret` and `static-auth-secret` on coturn). The development
container does this and also sets `--external-ip=127.0.0.1`,
`--allow-loopback-peers`, `--no-tls`, and a tiny relay range on loopback. Those
flags are for one host. A public relay publishes a reachable listening address
and relay range, and every URL in `DESKFLEET_TURN_URLS` must be an address both
peers can use.

`DESKFLEET_STUN_URLS` is independent. TURN URLs are not also advertised as
STUN. An empty ICE list is valid: peers then try direct candidates only.
Clients and daemons take ICE servers only from peer grants, so operators change
STUN/TURN membership by updating these environment variables and restarting the
API; new grants pick up the new lists without client releases or hardcoded
public STUN servers.

TURN forwards DTLS. It does not decrypt sessions, and the API never sees the
DTLS private keys. Relay ports are the TURN server's configuration; the API
does not allocate them and does not have a port-range variable.

### Team TURN usage collection

The backend can collect coturn usage through a single Redis instance and store
it by Team in PostgreSQL. This records usage only.

Configure coturn's statistics connection, separately from its authentication:

```ini
redis-statsdb="ip=redis.internal port=6379 dbname=0 password=<redis-password> connect_timeout=5"
```

Set `DESKFLEET_TURN_USAGE_REDIS_URL` on the backend to the same Redis service,
for example `redis://:<redis-password>@redis.internal:6379/0` (URL-encode the
password), then restart the backend. Keep the existing TURN REST authentication
settings. Restrict Redis access to the TURN publishers and backend subscriber.
Configure every API replica against the same statistics stream. A PostgreSQL
lease selects one active subscriber and allows another replica to take over;
replicas do not count each broadcast independently. Pub/Sub channels span
database indices; use separate Redis services to isolate environments.

Saved peer grants map TURN usernames to Teams. The `cp_turn_usage` table stores
interval byte deltas with separate client-side and peer-side counters. Unknown
peers are skipped. Team/minute sent-byte aggregates update in the same transaction;
billing queries combine complete minutes with raw events at partial boundaries.

Team settings show **Plans & Usages** to every member, with unlimited allowances
for relayed traffic, active Sessions, and Team members. Relayed traffic is the
cumulative sum of sent bytes across both socket sides. Active Sessions are
unarchived Agent Sessions on the Team's enrolled machines, based on durable
Session admissions. Idle Sessions and offline machines still count; removed
machines and completed archives do not. Team members include administrators and
members, excluding pending invitations.

`GET /api/teams/{team}/usage` returns `relayedBytes` as a decimal string, plus
the current `activeSessionCount` and `memberCount` as numbers.

These counters measure coturn protocol bytes. Summing both sides' receive and
send counters counts forwarded traffic more than once. Inspect Team totals by
side with:

```sql
SELECT team_id, side,
       SUM(received_bytes) AS received_bytes,
       SUM(sent_bytes) AS sent_bytes
FROM cp_turn_usage
GROUP BY team_id, side;
```

[Redis Pub/Sub has no replay](https://redis.io/docs/latest/develop/pubsub/#delivery-semantics).
Notifications missed during Redis, coturn statistics, or subscriber downtime
cannot be recovered. Failed PostgreSQL writes are logged and skipped; an abnormal
TURN exit can also lose unreported traffic. Missing traffic remains unbilled.
Redis outages leave the API available, and the collector reconnects automatically.
If coturn's initial Redis DNS resolution or TLS setup fails, fixing the issue may
also require restarting coturn. The event format is defined in the
[coturn statistics schema](https://github.com/coturn/coturn/blob/4.18.0/turndb/schema.stats.redis).

## Database, backup, and upgrade

Create an empty database and a role, and put that URL in `DATABASE_URL`. The
first start creates `cp_migrations` and applies schema versions `1` (owned identity
and central records), `2` (TURN usage), `3` (site administration), `4` (Team
entitlements and subscriptions), `5` (multi-instance routing and shared
signaling), and `6` (query indexes, history summaries, shared expiry scheduling,
billing repair scheduling, and TURN minute aggregates) under the transaction
advisory lock `761946021`.
Later starts take the same lock and apply any migration that is not recorded.
Version 6 backfills summaries and TURN aggregates, so its first startup performs
work proportional to existing history and holds the usage write lock during
that backfill. Subsequent starts do not repeat it.

The provisional OIDC database is not compatible with this schema. That database
contained development data and must be rebuilt; see the
[development reset](environment.md#fresh-development-database-and-reset).

From a source checkout, the same database can be inspected with:

```sh
DATABASE_URL='postgres://...' \
  mise exec -- cargo run -p deskfleet-control-store --example migrate -- status
```

The example accepts `up`, `status`, and `down`. `down` drops every central
table and its rows, reverting the applied migration versions. It is a destructive
reset, not an upgrade step. The running server migrates on startup; production
does not need this example.

Take a logical dump of that database before replacing the binary or upgrading
PostgreSQL. `pg_dump` of `DATABASE_URL` is sufficient. The dump contains token
hashes and history replicas. It does not contain daemon credentials, provider
secrets, terminal transcripts, or worktree files.

Restoring an older dump brings back the hashes, revocations, and history as
they were at the dump. A daemon whose current machine token was issued after
the dump can no longer authenticate, and a removal performed after the dump is
undone. The supported recovery for a machine that cannot authenticate is
administrator removal, then `deskfleet-daemon prepare-enrollment`, then a new
enrollment. That keeps the old machine directory and does not import it.
Application sessions missing from the restored database simply sign in again.

To upgrade the API:

1. Dump PostgreSQL.
2. Stop the API instances.
3. Replace `deskfleet-server` with the new release binary.
4. Start the instances with the same `DATABASE_URL` and the same `DESKFLEET_PUBLIC_URL`.
5. Confirm `GET /healthz` returns `"status":"ok"` and the expected
   `protocol_version`.

Migrations finish before the new process listens. Daemons reconnect on their
own. A PostgreSQL major-version upgrade is a database operation: dump, load
into the new server, and point `DATABASE_URL` at that read-write instance. The
development Compose volume is pinned to PostgreSQL 18 for this reason; a
production major upgrade has the same constraint.

## Clients and machines

Build Electron and the headless daemon for each computer that will execute
agents. Supported targets are Linux x64, Linux arm64, macOS arm64, and Windows
x64. The daemon's SQLite catalog, provider configuration, and terminal history
stay in its data directory (`~/.deskfleet`, or `DESKFLEET_DAEMON_DIRECTORY`).

Build the clients for the API origin (`https://api.example.com` or the shared
hostname) as described above. On the welcome screen, sign in with a verified DeskFleet
account, create a team, and enroll the local daemon from the desktop app when
the app and the daemon are on the same computer.

For a headless machine, start `deskfleet-daemon`, then on that machine:

```sh
deskfleet-daemon status
```

Paste the printed identity into the client's Add machine dialog. The dialog
shows a credential once. On the headless machine, with its daemon already
running:

```sh
deskfleet-daemon enroll --server-url https://api.example.com < machine-credentials.json
```

`--server-url` must be `https`, except for `localhost`, `127.0.0.1`, and
`[::1]`. It must be an origin: no username, password, path, query, or fragment.
Enrollment checks the credential against `/api/daemon/me` and stores the
returned `serverId`. Later control connections must present that same
`serverId`.

After an administrator removes a machine, `status` reports `revoked`. Register
it again only after `deskfleet-daemon prepare-enrollment`, which prints a new
identity. An active registration cannot be overwritten.

The Web client is bundled in the official image, or can be deployed from
`apps/web/dist` to an independent static host. Browsers
need no daemon. They can read synchronized history while a machine is offline
and can open live Agent, Git, terminal, desktop, and file peers when it is
online and a path or TURN relay exists.

## Check a new deployment

1. `curl https://api.example.com/healthz` returns
   `{"status":"ok","version":"...","protocol_version":1}`.
   Open `/` and `/auth/account` at the Web origin and verify that static assets
   load. Missing API routes and assets should return 404, not the Web entry point.
2. Registration sends a verification email through your SMTP relay.
3. Verify the mailbox, sign in through Web and Electron, and create a Team.
4. A daemon enrolls and the client shows it online. The API log includes the
   bind address at startup (`DeskFleet server listening`).
5. An Agent or terminal session connects directly, and again with a forced
   relay if you depend on TURN. The development check for that path is
   `mise -E development run backend:smoke-relay`; it uses the local Compose
   relay, not your production TURN.

## Pitfalls

- `compose.yaml` published ports and mail-file delivery are local development fixtures.
- `DESKFLEET_PUBLIC_URL` changing after enrollment makes daemons reject the
  control socket with `Control identity mismatch`. Peer grants also carry that
  string. Keep the value stable, including whether it has a trailing slash.
- Set the public origin once, without a path or trailing slash.
- `DESKFLEET_BIND_ADDR=localhost:8080` fails. The value is an IP and port.
- Binding a public interface without the TLS proxy exposes session tokens.
  Bearer tokens travel in `Authorization` and in the first WebSocket message.
- SMTP delivery problems prevent new mailbox verification and recovery. Existing
  sessions keep working. Fix delivery and request a new link.
- Changing the WebAuthn RP ID or Web hostname can make existing Passkeys unusable.
- `DESKFLEET_WEB_ORIGINS` entries are exact origins, not pages.
- Building the Web client without `VITE_DESKFLEET_SERVER_URL` makes it call the
  page origin. That is correct for one hostname and wrong for a split host.
- A proxy timeout at or below 60 seconds drops daemons that are only sending
  heartbeats. A body limit under 64 MiB rejects large history uploads.
- `/healthz` staying green does not mean PostgreSQL or SMTP is healthy after startup.
- Replicas must share PostgreSQL and use the same public origin and service
  configuration. A healthy HTTP listener alone does not prove routing is available.
- Restoring a database dump without the matching machine credentials leaves
  those daemons unable to sign in. There is no in-place token rewrite.
- `migrate -- down` deletes the central database contents.
- TURN URLs that contain the development external address `127.0.0.1` only
  work for peers on that same host.

## Related documents

- [Server guide](../../apps/server/README.md): routes, auth details, and tests.
- [Development environment](environment.md): local Compose, including why its
  ports and passwords are not for hosting.
- [Web client](../../apps/web/README.md): static build and
  `VITE_DESKFLEET_SERVER_URL`.
- [Daemon guide](../../apps/daemon/README.md): enrollment commands and machine
  storage.
- [Backend scope](backend.md): what the API is responsible for.
- [WebRTC authorization](webrtc-security.md): peer grants, DTLS, and the
  24-hour ceiling.
