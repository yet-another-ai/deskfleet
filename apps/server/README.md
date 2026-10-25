# deskfleet server

An API-only Actix Web control plane backed by PostgreSQL. It owns OIDC identities,
application sessions, Teams and roles, machine enrollment, management RPC routing,
trusted WebRTC signaling, and read replicas of daemon catalogs and Agent journals.
The independently deployed Vue Web frontend and Electron use the same API.
Execution, provider processes, files, PTYs, and terminal output stay on the daemon.
See the [backend scope](../../agents/docs/backend.md) and
[WebRTC authorization](../../agents/docs/webrtc-security.md).

## Run and configure

For local development, the repository's Docker Compose supplies PostgreSQL, a
Dex OIDC provider with two test accounts, and coturn. From the repository root:

```sh
mise run infra:up
mise -E development run dev
```

See the [development environment](../../agents/docs/environment.md#local-docker-compose)
for login credentials, Web/Electron startup, isolated test databases, and cleanup.

For your own services, use PostgreSQL 17 or later and the locked toolchain:

```sh
DATABASE_URL='postgres://deskfleet:password@127.0.0.1:5432/deskfleet' \
DESKFLEET_OIDC_ISSUER='https://identity.example.com' \
DESKFLEET_OIDC_CLIENT_ID='deskfleet' \
DESKFLEET_OIDC_CLIENT_SECRET='from-your-identity-provider' \
DESKFLEET_PUBLIC_URL='https://api.example.com' \
DESKFLEET_OIDC_RETURN_TO='https://app.example.com/,http://127.0.0.1:*/auth/callback' \
DESKFLEET_WEB_ORIGINS='https://app.example.com' \
mise exec -- cargo run -p deskfleet-server --locked
```

Register `https://api.example.com/api/auth/callback` as the OIDC provider's exact
redirect URI. `DESKFLEET_OIDC_RETURN_TO` is a comma-separated allowlist of final
application callbacks. Browser URLs must match the Web application's entry URL
exactly, including its pathname and trailing slash. The one supported
wildcard, `http://127.0.0.1:*/auth/callback`, allows Electron's ephemeral loopback
port; it does not permit other hosts, paths, queries, or credentials. The OIDC
callback redirects with a short-lived one-use `#loginCode`. The initiating client
exchanges it together with the `loginVerifier` returned by `/api/auth/start`.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL. SQLite is rejected. |
| `DESKFLEET_BIND_ADDR` | IP and port; defaults to `127.0.0.1:8080`. |
| `DESKFLEET_PUBLIC_URL` | Stable external API origin and server identity; defaults to `http://127.0.0.1:8080`. |
| `DESKFLEET_OIDC_ISSUER` | OIDC discovery issuer. Without it, login is unavailable; there is no authentication bypass. |
| `DESKFLEET_OIDC_CLIENT_ID` | Required when an issuer is configured. |
| `DESKFLEET_OIDC_CLIENT_SECRET` | Confidential OIDC client secret, when required by the IdP. |
| `DESKFLEET_OIDC_RETURN_TO` | Comma-separated application callback allowlist. |
| `DESKFLEET_WEB_ORIGINS` | Comma-separated browser origins permitted by CORS. |
| `DESKFLEET_STUN_URLS` | Optional comma-separated STUN URLs. |
| `DESKFLEET_TURN_URLS` | Optional comma-separated TURN/TURNS URLs. |
| `DESKFLEET_TURN_SECRET` | Required with TURN URLs; shared with coturn's REST credential mechanism. |
| `RUST_LOG` | Log filter; defaults to `info`. |

For official hosting, run one server instance behind a TLS reverse proxy that
supports WebSocket upgrades, request bodies of at least 64 MiB, and idle periods
longer than the 20-second heartbeat. Serve the Web application separately. Store
PostgreSQL data on persistent storage and supply database/OIDC/TURN secrets via
the deployment's secret mechanism. `DESKFLEET_PUBLIC_URL` must remain stable.
Live socket routing and pending SDP exchanges are process-local, so this release
requires one central instance; adding instances needs shared routing first.

`GET /healthz` reports process liveness and protocol version. Database migrations
and configured OIDC discovery complete before the HTTP listener starts. Database,
migration, or discovery failures stop startup. Actix handles graceful shutdown.

## Authentication and API

All protected HTTP requests use `Authorization: Bearer <opaque token>`. OIDC
Authorization Code flow uses PKCE, state, nonce, and ID token signature, issuer,
audience, and expiration validation. PostgreSQL stores hashes of application,
machine, invitation, and exchange tokens; it stores OIDC flow state with short expirations. Application sessions last 30 days; machine credentials
remain valid until administrator revocation. Daemons persist their enrollment
credential locally, and clients persist their application session securely.
Machine removal leaves Team membership intact. A removed installation must
prepare a fresh empty data directory and origin before enrolling again, including
when returning to the same Team; the old machine's credentials and origin cannot
be reused. Old replicas stay scoped to the removed central machine ID.

The `/api` routes cover:

- `/auth/start`, `/auth/callback`, `/auth/exchange`, `/auth/logout`, and `/me`.
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
WS authentication/access failures close with 4401/4403; transient routing replacement
uses 1012. Explicit revocation has an independent shutdown path if outbound queues
are full. Transport loss alone preserves existing WebRTC peers until their fixed
24-hour deadline; it never stops tasks or shells.

TURN credentials use expiring coturn REST usernames and HMAC-SHA1 passwords. The
trusted center binds each exact SDP exchange and ICE generation to one actor,
Team, target machine, and purpose. The WebRTC stacks perform certificate fingerprint
verification during DTLS. Failed negotiation requires a new peer authorization.

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
example supports `up`, `status`, and `down`; `down` of version 1 drops central tables
and their data. The daemon's `db:migrate` task manages a different SQLite database.

```sh
mise exec -- cargo run -p deskfleet-control-store --example migrate -- status
```

## Verification

Unit tests run without PostgreSQL. Integration tests require a PostgreSQL instance.
Each run creates uniquely scoped fixture identities.

```sh
mise exec -- cargo test -p deskfleet-protocol -p deskfleet-server -p deskfleet-control-store --locked
TEST_DATABASE_URL='postgres://postgres:password@127.0.0.1:5432/deskfleet_test' \
  mise exec -- cargo test -p deskfleet-control-store -p deskfleet-server --locked -- --ignored
```

The backend smoke script additionally exercises a fixture OIDC provider, the live
HTTP/WebSocket server, daemon synchronization, and actual WebRTC data channels.
