# Official hosted trial deployment

The `v0.1.0` rollout is an initial official deployment for finding and fixing
integration problems. This checklist describes the required services,
configuration, and acceptance steps; it does not record a completed deployment.
The [server guide](../../apps/server/README.md) owns API configuration,
[self-hosted operations](self-hosted.md) owns shared infrastructure procedures,
and [Stripe operations](stripe.md) owns payment setup.

## Deployment scope

Start with `DESKFLEET_DEPLOYMENT_MODE=hosted`, a Free Team, and an Enterprise
test Team granted by a Site Admin. This exercises hosted policy and TURN without
requiring payments. Include Redis to verify TURN usage collection. Then enable
Stripe test mode to exercise Go/Pro subscriptions and metered relay access.
These are separate acceptance steps; Enterprise bypasses the paid-plan metering
gate and cannot establish that Go/Pro billing works.

| Service | Required for | Deployment responsibility |
| --- | --- | --- |
| `deskfleet-server` | Every deployment | API processes/containers sharing PostgreSQL and one public origin. PostgreSQL coordinates socket ownership, cross-instance routing, and SDP exchanges. |
| PostgreSQL | Every deployment | Persistent central accounts, Teams, machine registrations, history, billing, and usage, plus transient routing payloads. Startup applies migrations; the database role needs schema modification rights. Development and CI currently use PostgreSQL 18.6. |
| Web static host | Every official deployment | Serve `apps/web/dist/`, including an `index.html` fallback for `/auth/*`. Electron also uses these pages for browser login. |
| HTTPS/WSS reverse proxy | Every public deployment | Terminate TLS and forward `/api` and `/healthz` to the API. It can also serve the static Web files. |
| SMTP relay | Public registration and recovery | Authenticated STARTTLS delivery, normally port 587. Public deployments cannot use the local mail-file sink. |
| coturn | Public relay and cross-network smoke tests | Public STUN/TURN endpoints, REST shared-secret authentication, reachable relay ports. TURN traffic goes directly between peers and coturn. |
| Redis | TURN usage collection and Go/Pro relay | Receive coturn statistics via Pub/Sub; the API persists usage to PostgreSQL. This is not a general application cache or job queue. |
| Stripe | Payment acceptance tests | External test-mode service with Product, Go/Pro Prices, Portal configuration, and webhook endpoint. Optional until payment testing begins. |
| Test machines | End-to-end acceptance | Install Electron and/or the standalone daemon, Git, and an authenticated real Agent CLI on the execution machines. |

The API contains its billing reconciliation worker and TURN collector; neither
needs a separate worker service. Accounts are DeskFleet-owned, so no OIDC service
is required. There is no central object store. Workspaces, Agent credentials,
SQLite journals, and terminal transcripts remain on enrolled machines.
Replicas need no new routing environment variables or Redis broker. Configure
them with the same database and service settings; routing process IDs are
generated at startup. The TURN collector uses its existing PostgreSQL lease to
select one subscriber across replicas.
Cross-instance RPC inboxes can temporarily contain provider environment values
and other operation parameters/results. They have a 120-second expiry and are
removed on consumption or expiry cleanup, without router payload logging.
Database backups may retain them; protect database and backup access accordingly.
See the [data boundary](self-hosted.md#what-this-release-runs).

## Domains and network

For the first deployment, one origin for the application and API allows use of
the existing Web build artifact. The following names are examples, not
provisioned official domains:

| Endpoint | Example | Routing |
| --- | --- | --- |
| Application and API | `https://fleet.example.com` | `/api` and `/healthz` to the API; all other paths to Web static files with SPA fallback. |
| STUN/TURN | `turn.example.com` | Public UDP/TCP listener and configured relay range. It does not pass through the HTTP proxy. |
| Product website | Existing `www.deskfleet.org` | The separate VitePress/GitHub Pages site; it does not serve the application login. |

The proxy must support WebSocket upgrades on `/api/client/ws` and
`/api/daemon/ws`, request bodies of at least 64 MiB, and read/idle timeouts
greater than 60 seconds. Forward the original Stripe webhook body. Overwrite
`X-Real-IP` with the actual client address and trust only the proxy's exact TCP
source IPs in the API configuration. Keep database and Redis access internal.

For split application/API hosts, use same-site HTTPS origins such as
`app.example.com` and `api.example.com`. Build the Web app with the API URL and
allow its Web origin in CORS. Unrelated cross-site domains are unsupported by
the SameSite=Lax login cookies.

## API runtime environment

Inject these through the container or process supervisor. The server does not
load a `.env` file itself. Values below are placeholders for a same-origin,
container-based deployment; replace hosts and secrets before use.

```dotenv
DATABASE_URL=postgres://deskfleet:REPLACE_DB_PASSWORD@postgres.internal:5432/deskfleet
DESKFLEET_BIND_ADDR=0.0.0.0:8080
DESKFLEET_PUBLIC_URL=https://fleet.example.com
DESKFLEET_AUTH_WEB_URL=https://fleet.example.com
DESKFLEET_WEBAUTHN_RP_ID=fleet.example.com
DESKFLEET_DEPLOYMENT_MODE=hosted

DESKFLEET_SMTP_HOST=smtp.example.com
DESKFLEET_SMTP_PORT=587
DESKFLEET_SMTP_USERNAME=REPLACE_SMTP_USERNAME
DESKFLEET_SMTP_PASSWORD=REPLACE_SMTP_PASSWORD
DESKFLEET_MAIL_FROM=deskfleet@example.com

DESKFLEET_STUN_URLS=stun:turn.example.com:3478
DESKFLEET_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
DESKFLEET_TURN_SECRET=REPLACE_SHARED_TURN_SECRET
DESKFLEET_TURN_USAGE_REDIS_URL=redis://:REPLACE_REDIS_PASSWORD@redis.internal:6379/0
RUST_LOG=info
```

Also set `DESKFLEET_TRUSTED_PROXY_IPS` to the proxy IPs actually observed by the
API. A Docker bridge proxy address is not necessarily `127.0.0.1`. The template
omits this topology-dependent value. URL-encode credentials inside connection
URLs and use the database/Redis TLS options required by those services.

| Variable | Requirement and default |
| --- | --- |
| `DATABASE_URL` | Required nonempty `postgres://` or `postgresql://` URL. Includes credentials, database, and driver options such as `sslmode`; no separate pool-size or database-TLS variable. |
| `DESKFLEET_BIND_ADDR` | IP:port, default `127.0.0.1:8080` for the binary. The image defaults to `0.0.0.0:8080`; expose it through the proxy. |
| `DESKFLEET_PUBLIC_URL` | Set explicitly to the stable HTTPS API origin, without a path or trailing slash. Default is `http://localhost:8080`. This string is also the enrolled machines' server identity. |
| `DESKFLEET_AUTH_WEB_URL` | Set explicitly to the HTTPS Web origin. Used for email links, Passkeys, Electron authorization, and Stripe return URLs. Defaults to the first Web origin, otherwise the API origin. |
| `DESKFLEET_WEB_ORIGINS` | Empty by default; can remain unset for same-origin hosting. For split hosts, set the exact Web origin. Supports comma-separated origins, credentialed CORS, and `X-CSRF-Token`. |
| `DESKFLEET_WEBAUTHN_RP_ID` | Defaults to the Web hostname. Keep the hostname and RP ID stable for existing Passkeys. |
| `DESKFLEET_TRUSTED_PROXY_IPS` | Empty by default. Comma-separated exact IPs, not CIDRs, trusted to supply `X-Real-IP` for authentication rate limits. |
| `DESKFLEET_DEPLOYMENT_MODE` | Set `hosted`. Default `self-hosted` has unlimited allowances and rejects Stripe configuration. |
| `DESKFLEET_SMTP_HOST` | Required outside local development. |
| `DESKFLEET_SMTP_PORT` | Default `587`; the implementation uses STARTTLS. Changing the port does not select implicit TLS. |
| `DESKFLEET_SMTP_USERNAME` | Required nonempty relay username when SMTP is configured. |
| `DESKFLEET_SMTP_PASSWORD` | Required nonempty relay password; secret. |
| `DESKFLEET_MAIL_FROM` | Required valid sender mailbox when SMTP is configured. |
| `DESKFLEET_STUN_URLS` | Optional comma-separated `stun:`/`stuns:` URLs. Empty by default; there is no built-in public STUN service. |
| `DESKFLEET_TURN_URLS` | Optional for startup, needed for relay tests. Comma-separated `turn:`/`turns:` URLs reachable from both peers. |
| `DESKFLEET_TURN_SECRET` | Required when TURN URLs are set; secret shared with coturn's `static-auth-secret`. |
| `DESKFLEET_TURN_USAGE_REDIS_URL` | Empty/unset disables collection. `redis://` or `rediss://`; required for Go/Pro metering. An unavailable Redis is retried in the background. |
| `RUST_LOG` | Defaults to `info`; controls the server log filter. |
| `DESKFLEET_MAIL_DIRECTORY` | Local development only, default `.local/mail`. Omit in the official deployment. |

Configuration is read at startup. Restart the API after changes; new peer grants
receive updated ICE settings. Changing `DESKFLEET_PUBLIC_URL` after enrollment
is not a supported retargeting procedure.

### Stripe test-mode environment

Leave all Stripe payment variables unset during the initial Free/Enterprise pass.
To test payments, configure all eight from the same Stripe test environment:

```dotenv
DESKFLEET_STRIPE_SECRET_KEY=REPLACE_STRIPE_TEST_SECRET_KEY
DESKFLEET_STRIPE_WEBHOOK_SECRET=REPLACE_STRIPE_TEST_WEBHOOK_SECRET
DESKFLEET_STRIPE_GO_PRICE_ID=REPLACE_GO_MONTHLY_PRICE_ID
DESKFLEET_STRIPE_PRO_PRICE_ID=REPLACE_PRO_MONTHLY_PRICE_ID
DESKFLEET_STRIPE_GO_YEARLY_PRICE_ID=REPLACE_GO_YEARLY_PRICE_ID
DESKFLEET_STRIPE_PRO_YEARLY_PRICE_ID=REPLACE_PRO_YEARLY_PRICE_ID
DESKFLEET_STRIPE_PORTAL_CONFIGURATION_ID=REPLACE_MONTHLY_PORTAL_CONFIGURATION_ID
DESKFLEET_STRIPE_YEARLY_PORTAL_CONFIGURATION_ID=REPLACE_YEARLY_PORTAL_CONFIGURATION_ID
# Optional Enterprise sales mailbox on Plans & Usage:
# DESKFLEET_ENTERPRISE_CONTACT_EMAIL=sales@example.com
```

Partial Stripe configuration fails startup. The four Prices must be distinct,
positive fixed amounts (monthly and yearly recurring), on the same Product and
currency, with Go cheaper than Pro in each interval. Use two Portal
configurations (monthly Prices only, yearly Prices only) as described in
[Stripe operations](stripe.md#billing-portal). Register
`https://fleet.example.com/api/billing/stripe/webhook` using the supported events
in [the webhook handler](../../apps/server/src/billing/webhook.rs). There is no
frontend Stripe publishable-key environment variable in this Checkout flow.

### Configuration owned by other services

- PostgreSQL: create the database and login used in `DATABASE_URL`. If using the
  PostgreSQL container image, its initialization uses `POSTGRES_DB`,
  `POSTGRES_USER`, and `POSTGRES_PASSWORD`; these are not server settings.
- coturn: configure `realm`, `use-auth-secret`, matching `static-auth-secret`,
  the public listening/external address, and `min-port`/`max-port` relay range.
  Enable `redis-statsdb` against the same Redis service as the API collector.
  `turns:` URLs also require coturn TLS listeners and certificates. The repository
  Compose loopback address, development secret, and `allow-loopback-peers` are
  local fixtures, not public deployment values.
- Redis: configure private reachability and credentials for both coturn and the
  API. There is no DeskFleet-defined Redis-server password variable. Pub/Sub has
  no replay; separate Redis instances isolate environments, not database indices.
- Test machines: `DESKFLEET_DAEMON_DIRECTORY` optionally selects the daemon data
  directory (default `~/.deskfleet`). Enroll using `--server-url` and the issued
  credential on stdin. Provider credentials belong on that machine.

## Build and tag configuration

`VITE_DESKFLEET_SERVER_URL` is a Web and Electron **build-time** variable. Leave
it unset for the same-origin production Web layout above. For split hosts, build Web with
`VITE_DESKFLEET_SERVER_URL=https://api.example.com`, set the API's
`DESKFLEET_AUTH_WEB_URL=https://app.example.com` and
`DESKFLEET_WEB_ORIGINS=https://app.example.com`. Changing the static host's runtime
environment does not rewrite an existing bundle. Electron defaults to
`http://localhost:8080`. Set `VITE_DESKFLEET_SERVER_URL=https://fleet.example.com`
in the GitHub `production` environment for official desktop artifacts; the tag
build rejects a missing or empty value and injects it only into Electron. The
tagged Web artifact stays same-origin. Neither client exposes a backend-address
setting. Changing a compiled API origin requires rebuilding that client; an
unset production Web build follows the origin serving its page.

Create the `production` environment under Repository Settings → Environments.
Use **Selected branches and tags** with a **Tag** rule matching `v*` and no
allowed branches. Store production variables and secrets only in this
environment, removing repository and organization copies. PR, main, and manual
Build runs do not bind it: Statsig stays disabled, and Electron retains its
localhost backend. See [tagged releases](ci.md#tagged-releases) for the complete
configuration.

Statsig is optional and configured at build time for both Web and Electron. The
tag build workflow reads the `production` environment variables
`VITE_STATSIG_CLIENT_KEY` and `VITE_STATSIG_ENVIRONMENT`; neither is required. Use a
Statsig client-public SDK key, which is included in the distributed JavaScript,
never a server secret key. An unset or blank key disables the integration. The
environment defaults to the Vite mode when its value is absent or blank; set it
explicitly when a build mode should report to a different Statsig environment.
Local builds accept the same process environment variables. A change requires
rebuilding and redistributing the affected clients, not restarting the API.

For verified payment conversions, separately configure the API runtime with
`DESKFLEET_STATSIG_SERVER_KEY` and `DESKFLEET_STATSIG_ENVIRONMENT` (default
`production`) for the same Statsig project/tier. This server key is secret and
must never enter a frontend build. Migration 10 adds the durable billing event
outbox; its delivery worker is independent of Stripe reconciliation. The
[analytics guide](analytics.md#payment-funnel) defines conversion metrics and
delivery guarantees. Both frontend and backend analytics are optional.

When enabled, allow `https://featureassets.org`, `https://prodregistryv2.org`, and
`https://statsigapi.net` in the Web host's `connect-src` policy. The Electron
build adds these origins only when its key is configured. Statsig owns behavioral
analytics and frontend experiments; API/daemon authorization and quota admission
remain authoritative. See the [Web](../../apps/web/README.md) and
[desktop](../../apps/desktop/README.md) guides for environment-file locations.

The tag workflow requires these secrets in the GitHub `production` environment,
separate from API secrets:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate/private key in PKCS#12 format. |
| `MAC_CSC_KEY_PASSWORD` | Password for the PKCS#12 archive. |
| `APPLE_API_KEY_P8` | Base64 App Store Connect API private key. |
| `APPLE_API_KEY_ID` | App Store Connect API key ID. |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID. |

macOS signing/notarization is mandatory for tag builds. Its failure blocks both
the draft release and API image publication. GHCR uses the workflow's
`GITHUB_TOKEN`; no separate registry password secret is required. Verify GHCR
package visibility after the first push if anonymous pulls are needed.

Before tagging, account for these current behaviors:

1. **`v0.1.0` is classified as stable by the existing workflow.** It creates a
   draft GitHub Release but also pushes both `:0.1.0` and `:latest` API image
   tags. The draft does not delay the image push. Keeping this exact tag while
   treating it as a prerelease requires a workflow policy change; a SemVer
   prerelease suffix uses the existing prerelease path. See
   [tag classification](../../scripts/release-version.ts) and
   [Publish](../../.github/workflows/publish.yml).
2. The tag must match the root package, desktop package, and Cargo workspace
   versions. Follow [tagged releases](ci.md#tagged-releases) for version/lockfile
   updates and asset review. `PROTOCOL_VERSION` remains `1`.
3. The workflow publishes an amd64/arm64 API image and draft desktop/daemon
   assets. It does not deploy the API or Web application. `deskfleet-web` is a
   same-origin Actions artifact retained for 14 days, not a GitHub Release asset;
   retain and deploy the build from the selected tag.
4. The repository has no production Compose stack. The server image contains
   only the API, runs as UID/GID `10001:10001`, and needs no application data
   volume. PostgreSQL and execution-machine data need persistent storage.

## Deployment and smoke sequence

1. Provision DNS/TLS, PostgreSQL, SMTP, coturn, and Redis. Deploy the selected Web
   build and at least two API instances sharing the environment above for the
   multi-instance acceptance pass. Keep the API origin stable and take a database
   backup before subsequent upgrades. Use one public load balancer without
   requiring client affinity.
2. Check public `/healthz` for the expected version and `protocol_version: 1`.
   Open `/auth/account` directly to check SPA fallback. Exercise a database-backed
   API through login; `/healthz` is process liveness and can stay green during a
   later database outage.
3. Register with a real mailbox, verify the email, set a password, sign in on
   Web and Electron, receive a recovery email, and add/use a Passkey. This checks
   SMTP, origins, cookies, CSRF, RP ID, and the desktop loopback callback.
4. Obtain the registered user's UUID from `/api/me` and run
   `deskfleet-server site-admin grant <user-id>` with `DATABASE_URL` supplied.
   The first account does not become Site Admin automatically. Use Web Site
   administration to label the trial via the announcement, set registration and
   Team-creation policy, and grant Enterprise to a test Team. These are persisted
   settings, not environment variables. Keep another Team Free for policy tests.
5. Enroll an independently hosted machine, install/authenticate a real Agent
   CLI, and create a Workspace. In both Web and Electron, create directory and
   worktree Sessions, run an Agent turn, inspect Git changes, open a terminal,
   and transfer a file. Test desktop capture/input on a supported machine with
   permissions granted.
6. Verify direct connectivity, then force traffic through the public TURN service
   using controlled test networking or a relay-only test client. Record the
   selected ICE candidate pair to prove relay use; a successful connection alone
   is insufficient. Test each advertised transport, including TCP/TLS when used.
   `DESKFLEET_SMOKE_RELAY_ONLY` and `DESKFLEET_SMOKE_FORCE_RELAY` are test-harness
   switches, not API deployment settings.
7. Confirm Free peer grants omit TURN with `relayDeniedReason=free_plan` and
   the Enterprise test Team can relay. Generate actual relay traffic and verify
   Team usage `relayedBytes` increases. `metering.fresh` alone only establishes
   the collector's Redis/database heartbeat, not coturn statistics delivery.
8. Close the client and confirm work continues on the daemon; reopen and recover
   the view. Archive/restore a Session and verify files/history survive, with
   restore leaving execution stopped. Take the machine offline and read its
   synchronized history. Place the client and daemon sockets on different API
   instances and alternate management and offer/candidate HTTP requests between
   instances. Verify replies, client notifications, logout revocation,
   and machine removal reach the correct sockets. Stop the daemon's API instance,
   confirm reconnection through a surviving instance and history synchronization,
   and verify the old connection cannot remove the new route. Retry interrupted
   operations only after checking their receipts. Temporarily deny an instance's
   database access and confirm it closes signaling rather than continuing to
   trust local routes; restore access and confirm recovery.
9. Enable the eight Stripe test settings. Complete monthly and yearly Checkout,
   confirm the webhook and paid entitlement, then test Portal upgrade, downgrade,
   and cancellation within each interval (Portal does not switch intervals).
   Use a Go/Pro Team to verify relay and usage. Missing/stale metering must deny
   new metered relay credentials (`metering_unavailable`); exhausting allowance
   must deny new relay (`turn_quota_exhausted`). Existing grants retain their
   bounded lifetime. A browser redirect alone must not establish paid coverage.

Record core hosted acceptance (Free/Enterprise) separately from payment
acceptance (Stripe test mode/Go/Pro). Existing `backend:smoke` and
`backend:smoke-clients` start local fixtures, force `self-hosted`, use local mail
files and scripted providers, and disable Stripe. `backend:smoke-relay` exercises
those fixtures, and image smoke checks startup/migrations/health/shutdown. They
remain useful regression checks but do not validate the public deployment.
