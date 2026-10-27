# Self-hosted backend

This guide is the production deployment of deskfleet's central API. It covers
the `deskfleet-server` process, PostgreSQL, an OIDC provider, a TLS reverse
proxy, an optional TURN relay, and the separately hosted Web client.

The [server guide](../../apps/server/README.md) owns the HTTP API and local
configuration. The [development environment](environment.md#local-docker-compose)
owns the loopback Compose stack. That stack is not a production layout: every
published port binds to `127.0.0.1`, the passwords are public development
credentials, and the API process is not one of the containers.

## What this release runs

One operating-system process of `deskfleet-server` speaks plain HTTP. Actix
workers inside that process share one in-memory socket router and one pending
SDP table. A second process, container replica, or host does not share that
state. Live socket routing and unfinished SDP exchanges are process-local, so
this release runs a single API instance. More instances need shared routing
first.

The process does not terminate TLS, serve the Vue application, store files, or
run agents. Daemons stay on the computers they enroll. The API authorizes
management calls and WebRTC signaling, then stores account data and replicas of
catalogs and Agent history.

PostgreSQL holds the central records; optional Redis carries TURN usage
notifications. There is no object store. The tables are the `cp_*` schema created
in the connection's search path (normally `public`). Startup applies them before
the listener opens.

| Stored on the API's PostgreSQL database | Stays on the enrolled machine |
| --- | --- |
| OIDC user profile (`issuer`, `subject`, name, email) | Agent CLI credentials and provider environment values |
| Login-session, machine, invitation, and exchange-token hashes | Plaintext machine credential (`central.json`) |
| Teams, roles, and invitations | Workspace files, Git worktrees, and terminal transcripts |
| Machine enrollment, catalog snapshot, and display metadata for providers | Provider binary paths |
| Agent session snapshots, event pages, and command audit | Desktop media |

Stored provider rows keep id, template, name, and icon. Template rows keep id
and name. Binary paths and environment values are dropped. Terminal output is
never uploaded. A central backup therefore cannot rebuild a machine's working
directories, shells, or provider secrets.

`GET /healthz` is unauthenticated process liveness. The JSON body is
`status` (`ok`), `version` (the server package version), and
`protocol_version` (currently `1`, snake_case). It does not query PostgreSQL.
Migrations and OIDC discovery have already succeeded if the process is
listening; a later database outage leaves `/healthz` green while API calls fail.

`PROTOCOL_VERSION` is still provisional. Contracts evolve in place at version
`1` until maintainers declare a freeze.

## Explicitly unsupported

- More than one API process. In-memory routing is not shared.
- A production Compose file or container image for the API. `compose.yaml` is
  the local development dependency stack only.
- TLS inside `deskfleet-server`. The listener is HTTP. The binary does not read
  `X-Forwarded-*` or a certificate path.
- Password login, a built-in user directory, or an authentication bypass.
  Leaving `DESKFLEET_OIDC_ISSUER` unset starts the process and rejects login
  with `OIDC login is not configured`.
- SQLite, or any `DATABASE_URL` that does not start with `postgres://` or
  `postgresql://`.
- Serving the Web UI from the API process.
- Permanent Session deletion. Archive and restore are the user-facing
  operations.
- Retargeting enrolled machines after `DESKFLEET_PUBLIC_URL` changes. The
  repository has no migration for that.
- Importing an old unauthenticated daemon directory into a team. Enrollment
  starts a new machine identity; `prepare-enrollment` keeps the old files in
  place and does not copy them.

## Prerequisites

- PostgreSQL 17 or later, the version used by development and CI. The server
  does not probe the major version. The connected role needs to create and
  modify tables in its search path.
- An OIDC provider that can serve discovery, sign ID tokens, and allow the
  authorization-code grant with PKCE S256. The API asks for `openid`,
  `profile`, and `email`.
- A TLS reverse proxy that can upgrade WebSockets, accept request bodies of at
  least 64 MiB, and keep a connection idle for more than 60 seconds.
- A TURN server that implements the REST credential mechanism, when peers
  cannot connect directly. STUN is optional.
- The `deskfleet-server` binary for the host, and a static build of the Web
  client if browsers will use it. Build the daemon and Electron for the
  computers that execute agents; they do not run on the API host.
- The API host's clock must satisfy the OIDC library's ID-token expiry checks.
  The server does not expose a clock-skew setting.

Build the API from this repository. CI compiles the same server and daemon
binaries for Linux x64, Linux arm64, macOS arm64, and Windows x64, and the
Linux x64 job also uploads a Web client built without
`VITE_DESKFLEET_SERVER_URL` (that build calls the origin that serves the page).
Those uploads are workflow artifacts kept for 14 days. They are not a hosted
release of the API.

## Recommended layout

Put PostgreSQL, the API, and the proxy on a network where only the proxy is
reachable from clients. The API binds a loopback address. Browsers, Electron,
and daemons use the proxy's HTTPS origin. TURN, when you run it, is a separate
public UDP/TCP service; the API does not carry media.

```text
browsers, Electron, daemons
        |  HTTPS and WSS
        v
TLS reverse proxy
        |-- /api and /healthz --> 127.0.0.1:8080  deskfleet-server (one process)
        |-- everything else   --> apps/web/dist   (omit this if the Web app has its own origin)
        |
        +--> PostgreSQL (read-write URL in DATABASE_URL)
        +--> outbound HTTPS to the OIDC issuer (discovery, token, JWKS)

browsers and daemons  --UDP/TCP-->  TURN listening port and relay range
```

Two public shapes work:

| Shape | API origin | Web origin | What to set |
| --- | --- | --- | --- |
| One hostname | `https://fleet.example.com` | same | Leave `VITE_DESKFLEET_SERVER_URL` unset. `DESKFLEET_WEB_ORIGINS` can stay empty. Return URL is `https://fleet.example.com/`. |
| Split hosts | `https://api.example.com` | `https://app.example.com` | Build the Web client with `VITE_DESKFLEET_SERVER_URL=https://api.example.com`. Set `DESKFLEET_WEB_ORIGINS=https://app.example.com` and `DESKFLEET_OIDC_RETURN_TO=https://app.example.com/,http://127.0.0.1:*/auth/callback`. |

Electron always needs the loopback return entry, including in the one-hostname
shape. The daemon's `--server-url` is the API origin, with no path.

A process supervisor should restart the API on failure and inject the
environment from the host's secret store. The binary has no working-directory
requirement and does not need Node, mise, or a source checkout at runtime.
Stopping it with SIGINT or SIGTERM uses Actix Web's graceful shutdown. Daemons
reconnect and receive peer grants that are still valid in PostgreSQL.
Established WebRTC keeps working until revocation or the grant's original
24-hour deadline. A negotiation that was only in memory has to be started again.

## Build

From a checkout, with the locked toolchain:

```sh
mise install --locked
# Bake a split API origin into the Web client when it differs from the page.
# VITE_DESKFLEET_SERVER_URL=https://api.example.com
mise run build
```

`mise run build` produces:

- `target/release/deskfleet-server` (`.exe` on Windows)
- `apps/daemon/dist/deskfleet-daemon` (`.exe` on Windows)
- `apps/web/dist/` for the static Web client

`VITE_DESKFLEET_SERVER_URL` is read when the Web client is compiled. Changing
the API origin later means building `apps/web/dist` again. The welcome screen
can still point a single browser or Electron install at another origin; the Web
client keeps that choice in `sessionStorage` for the tab, and Electron stores
it with the account.

A debug build (`mise run dev` or `cargo build -p deskfleet-server`) is for
development. Production runs the release binary.

## Configuration reference

The process reads only these variables. Unknown names are ignored. Comma
separated lists are split on `,`, trimmed, and empty items dropped.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes |  | `postgres://` or `postgresql://` URL, including credentials, database name, and any driver options such as `sslmode`. Empty is rejected. Other schemes are rejected. There is no separate pool-size or database-TLS variable. |
| `DESKFLEET_BIND_ADDR` | no | `127.0.0.1:8080` | `IP:port` of the plain HTTP listener. A hostname is invalid. |
| `DESKFLEET_PUBLIC_URL` | no | `http://127.0.0.1:8080` | External origin and the server identity (`serverId`). Use an `https` origin with no path and no trailing slash. The raw string is what daemons store. |
| `DESKFLEET_OIDC_ISSUER` | for login | unset | Issuer URL. Discovery runs at startup. Unset disables login. An empty value is not "unset": the process still requires a client id and then fails discovery. |
| `DESKFLEET_OIDC_CLIENT_ID` | when an issuer is set |  | OIDC client id. Empty is rejected. |
| `DESKFLEET_OIDC_CLIENT_SECRET` | when the IdP requires a confidential client | unset | Sent on the token request when the variable is present, including when it is empty. Omit the variable for a public client that uses PKCE only. |
| `DESKFLEET_OIDC_RETURN_TO` | for login | empty | Comma-separated final application URLs. See below. |
| `DESKFLEET_WEB_ORIGINS` | for cross-origin browsers | empty | Comma-separated exact origins (`https://app.example.com`, with port if it is not the default). |
| `DESKFLEET_STUN_URLS` | no | empty | Comma-separated `stun:`/`stuns:` URLs advertised on peer grants. Invalid schemes fail startup. Empty means no STUN; deskfleet does not ship a public STUN default. |
| `DESKFLEET_TURN_URLS` | no | empty | Comma-separated `turn:`/`turns:` URLs advertised on peer grants. Invalid schemes fail startup. Setting any URL requires a secret. |
| `DESKFLEET_TURN_SECRET` | with TURN URLs | unset | Shared with the TURN server's REST `static-auth-secret`. Empty is treated as missing and startup fails when TURN URLs are set. |
| `DESKFLEET_TURN_USAGE_REDIS_URL` | no | unset | `redis://` or `rediss://` URL for [Team TURN usage collection](#team-turn-usage-collection). Empty disables collection. Invalid URLs fail startup; unavailable Redis is retried in the background. |
| `RUST_LOG` | no | `info` | `tracing` `EnvFilter`. A missing or invalid value falls back to `info`. |

The OIDC redirect URI is derived, not configured separately:

```text
{DESKFLEET_PUBLIC_URL without trailing slashes}/api/auth/callback
```

Register that exact string on the identity provider. The server also uses
`DESKFLEET_PUBLIC_URL` unchanged as `serverId` in `/api/daemon/me`, the
WebSocket `ready` message, and every peer grant.

Startup order is environment, PostgreSQL connection and migrations, OIDC
discovery, then the HTTP bind. A database, migration, or discovery failure
exits before `/healthz` exists. The OIDC client waits at most 15 seconds and
does not follow redirects. A callback whose signing key is missing refreshes
JWKS once.

Example, with secrets supplied by the supervisor rather than a shell history:

```sh
DATABASE_URL='postgres://deskfleet:password@127.0.0.1:5432/deskfleet?sslmode=require' \
DESKFLEET_BIND_ADDR='127.0.0.1:8080' \
DESKFLEET_PUBLIC_URL='https://api.example.com' \
DESKFLEET_OIDC_ISSUER='https://identity.example.com' \
DESKFLEET_OIDC_CLIENT_ID='deskfleet' \
DESKFLEET_OIDC_CLIENT_SECRET='from-your-identity-provider' \
DESKFLEET_OIDC_RETURN_TO='https://app.example.com/,http://127.0.0.1:*/auth/callback' \
DESKFLEET_WEB_ORIGINS='https://app.example.com' \
DESKFLEET_STUN_URLS='stun:turn.example.com:3478' \
DESKFLEET_TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp' \
DESKFLEET_TURN_SECRET='shared-with-the-turn-server' \
deskfleet-server
```

`sslmode` in that URL is a PostgreSQL driver option on `DATABASE_URL`, not a
deskfleet setting. Use the mode your database requires.

## Identity provider

The API implements the authorization-code flow with PKCE S256, `state`, and
`nonce`. It requires an ID token and checks the signature, issuer, audience,
and expiration. Access-token hashes inside the ID token are checked when the
token contains one. Users are uniquely `(issuer, subject)`. A later login
updates that user's name and email. A different issuer string, including a
trailing-slash change, creates a new user with no team membership.

The browser or Electron opens the provider. The provider redirects to
`/api/auth/callback`. The API then redirects to the allowlisted application URL
with a one-use fragment `#loginCode=...`. The client exchanges that code with
the `loginVerifier` it received from `POST /api/auth/start`. Application
sessions last 30 days. The exchange code lasts 60 seconds. The OIDC attempt
itself lasts 10 minutes. Logout revokes that application session and its peer
grants. There are no session cookies; clients send `Authorization: Bearer`.

`DESKFLEET_OIDC_RETURN_TO` is an exact-string allowlist, plus one wildcard:

- A Web entry must match `location.origin + location.pathname` of the page that
  starts login. The default static site at `/` produces
  `https://app.example.com/`, including the trailing slash. Hash routes are
  not part of this string.
- `http://127.0.0.1:*/auth/callback` allows Electron's ephemeral loopback port.
  It accepts any port on `127.0.0.1` with path `/auth/callback` and no query or
  fragment. `localhost` does not match it. No other wildcard is implemented.
- URLs with a username, password, query, or fragment are rejected.

The Web client stores its login in `sessionStorage`. Closing the tab drops it
even though the server session has time left. Electron keeps the account on
disk, encrypts the token when OS safe storage is available, and opens the
system browser for the OIDC redirect.

Team roles are deskfleet data. The OIDC account does not select them. The
person who creates a team is its admin. Invitations last 7 days. Machine
credentials last until an administrator removes the machine.

The development Dex service in `compose.yaml` is a local fixture with published
passwords. Point a production API at your own issuer. The issuer must be
reachable from the API host for discovery and token requests, and from browsers
for the authorization page.

## Reverse proxy

Proxy `/api` (HTTP and WebSocket) and `/healthz` to `DESKFLEET_BIND_ADDR`.
WebSocket routes are `/api/client/ws` and `/api/daemon/ws`. The first client
message is `{"type":"authenticate","token":"..."}` and must arrive within 10
seconds. Tokens are not placed in the URL.

The server sends a WebSocket ping every 20 seconds and closes a socket that has
been silent for 60 seconds. The daemon sends its own application ping on the
same 20-second cadence and closes after 60 seconds without a message. Set the
proxy's read and idle timeouts above 60 seconds.

JSON bodies and WebSocket frames are limited to 64 MiB. Set the proxy's request
body limit to at least 64 MiB. History uploads use `POST /api/daemon/history`.

CORS allows `GET`, `POST`, `PATCH`, and `DELETE`, and the headers
`authorization` and `content-type`. Preflight caching is 3600 seconds. An
`Origin` that is not in `DESKFLEET_WEB_ORIGINS` is not refused by the API; the
CORS headers are omitted and the browser rejects the response. Daemons and
Electron's main process are not affected. Same-origin Web hosting does not need
its own origin listed. There is no `*` origin. Credentialed CORS is not enabled.

The proxy terminates TLS. `DESKFLEET_PUBLIC_URL` must be the `https` origin
clients use. The API will not reconstruct that origin from `Host` or
forwarded headers.

This nginx fragment illustrates those requirements. It is not shipped or tuned
as a deskfleet component:

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
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

For one hostname, serve `apps/web/dist` at `/` and proxy only `/api` and
`/healthz`. The client uses hash URLs, so application routes do not need a
server-side fallback. Keep the document path at `/` so the return URL stays
`https://fleet.example.com/`. Redirecting `/` to `/index.html` changes the
return URL to `https://fleet.example.com/index.html`, which then has to be the
allowlist entry.

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
Run one backend collector per statistics stream to avoid counting broadcasts
multiple times. Pub/Sub channels span database indices; use separate Redis
services to isolate environments.

Saved peer grants map TURN usernames to Teams. The `cp_turn_usage` table stores
interval byte deltas with separate client-side and peer-side counters. Unknown
peers are skipped.

Team settings show **Plans & Usages** to every member, with unlimited allowances
for relayed traffic, active Sessions, and Team members. Relayed traffic is the
cumulative sum of sent bytes across both socket sides. Active Sessions are
unarchived Agent Sessions on the Team's enrolled machines, based on their latest
synchronized snapshots. Idle Sessions and offline machines still count; removed
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
first start creates `cp_migrations` and applies schema versions `1` (central
records) and `2` (TURN usage) under the transaction advisory lock `761946021`.
Later starts take the same lock and apply any migration that is not recorded.

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
2. Stop the one server process.
3. Replace `deskfleet-server` with the new release binary.
4. Start it with the same `DATABASE_URL` and the same `DESKFLEET_PUBLIC_URL`.
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

On the welcome screen, set the server field to the API origin
(`https://api.example.com` or the shared hostname). Electron's first launch
defaults that field to `http://127.0.0.1:8080`. Sign in through the identity
provider, create a team, and enroll the local daemon from the desktop app when
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

The Web client is the contents of `apps/web/dist` on any static host. Browsers
need no daemon. They can read synchronized history while a machine is offline
and can open live Agent, Git, terminal, desktop, and file peers when it is
online and a path or TURN relay exists.

## Check a new deployment

1. `curl https://api.example.com/healthz` returns
   `{"status":"ok","version":"...","protocol_version":1}`.
2. The identity provider lists the derived `/api/auth/callback` redirect.
3. The Web welcome page or Electron completes OIDC and can create a team.
4. A daemon enrolls and the client shows it online. The API log includes the
   bind address at startup (`deskfleet server listening`).
5. An Agent or terminal session connects directly, and again with a forced
   relay if you depend on TURN. The development check for that path is
   `mise -E development run backend:smoke-relay`; it uses the local Compose
   relay, not your production TURN.

## Pitfalls

- `compose.yaml` published ports and the accounts `alice@example.test` /
  `bob@example.test` exist only for local development.
- `DESKFLEET_PUBLIC_URL` changing after enrollment makes daemons reject the
  control socket with `Control identity mismatch`. Peer grants also carry that
  string. Keep the value stable, including whether it has a trailing slash.
- The callback strips trailing slashes from the public URL. The server identity
  does not. Set the origin once, without a path or trailing slash.
- `DESKFLEET_BIND_ADDR=localhost:8080` fails. The value is an IP and port.
- Binding a public interface without the TLS proxy exposes session tokens.
  Bearer tokens travel in `Authorization` and in the first WebSocket message.
- An OIDC issuer that is down, or whose discovery document redirects, prevents
  the process from listening.
- Reusing a development issuer URL, or editing the issuer string, orphans
  existing memberships because users are keyed by issuer and subject.
- `DESKFLEET_WEB_ORIGINS` entries are origins, not pages. A trailing path does
  not match the browser `Origin` header. The Web return URL is a separate
  setting and includes the path.
- Building the Web client without `VITE_DESKFLEET_SERVER_URL` makes it call the
  page origin. That is correct for one hostname and wrong for a split host.
- A proxy timeout at or below 60 seconds drops daemons that are only sending
  heartbeats. A body limit under 64 MiB rejects large history uploads.
- `/healthz` staying green does not mean PostgreSQL or the identity provider is
  healthy after startup.
- Two API replicas split presence and signaling. Clients of one replica cannot
  reach a daemon connected to the other.
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
