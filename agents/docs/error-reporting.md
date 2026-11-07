# Optional frontend error reporting

Web and Electron renderers use `@sentry/vue` through the shared Vue frontend.
Sentry captures Vue errors, uncaught JavaScript errors, and unhandled promise
rejections. Both clients also report central API transport, decoding, HTTP 5xx,
and rate-limit failures when their callers handle the error. The integration covers authentication, the root application, and
the separate Vue applications that render machine surfaces. It does not run in
the Rust server, daemon, or Electron main process.

## Build configuration

| Variable | Purpose |
| --- | --- |
| `VITE_SENTRY_DSN` | Public Sentry DSN. Missing, blank, or invalid values disable reporting. |
| `VITE_SENTRY_ENVIRONMENT` | Optional environment; defaults to the Vite mode when missing or blank. |

Use the project's public DSN, not a Sentry authentication token. Vite embeds
these values in distributed JavaScript. The DSN must use HTTP or HTTPS, contain
a public key and numeric project ID, and have no password, query, or fragment.
Self-hosted Sentry origins and path prefixes are supported.

```sh
export VITE_SENTRY_DSN=https://PUBLIC_KEY@sentry.example.com/1
export VITE_SENTRY_ENVIRONMENT=development
mise run dev
```

The same process environment applies to `mise run desktop:dev`,
`mise run web:build`, and `mise run desktop:build`. Vite reads app-local
environment files from `apps/web/.env*` and
`apps/desktop/src/renderer/.env*`; process environment values take precedence.
Changing these values requires rebuilding and redistributing the client.
Setting variables when starting an already-built server or desktop app does not
change its frontend configuration.

Tagged releases read the DSN and environment from the GitHub `production`
environment for both clients. The workflow automatically sets the same Sentry
release for Web and Electron from the Git tag, such as `deskfleet@v0.2.1`;
no release variable needs configuring. Local or custom builds may optionally
set `VITE_SENTRY_RELEASE` to label their events.

Tagged builds also set `VITE_SENTRY_DIST` to `web` or the packaging platform
(`linux-x64`, `linux-arm64`, `macos-arm64`, `windows-x64`). It separates main
bundles with identical filenames across platforms. Custom builds that upload
maps must use the same release and distribution in the SDK and upload command.

PR, main, and manual Build runs do not bind the production environment and leave
Sentry disabled. Keep production values out of repository and organization
variables. See [release configuration](ci.md#tagged-releases) for the
environment's tag restrictions.

## Collection and delivery

Reporting is independent of Statsig. A missing or invalid DSN leaves the Sentry
client uninitialized. With a configured DSN, delivery is best effort; the app
does not wait for a Sentry server before becoming usable.

Once the account is loaded, reports include its DeskFleet user ID and email
address, when available. The root application and authentication pages update
this identity when the account or email changes and clear it on sign-out and
teardown. Machine-surface applications share their root's identity. Reports
captured before the account loads or while signed out have no user identity.
Standalone preview and Mermaid windows load identity from account status and
refresh it on account-change and reconnection notifications.
Only the ID and email are retained; automatic user information collection stays
disabled.

The explicit integration list retains Sentry's standard `EventFilters` noise
filters. These drop opaque `Script error.` reports, the browser's
`ResizeObserver loop completed with undelivered notifications.` message, and
other browser/extension noise recognized by the installed SDK. This restores
the SDK's default filtering without enabling its other default integrations or
collecting additional data. Filtering an opaque report does not establish that
its underlying error is harmless; application exceptions with actionable
messages continue to be reported.

Desktop events include the operating system name and version, CPU architecture,
application version, and Electron, Node.js, and Chromium versions. Electron's
system version reports the macOS product version rather than the Darwin kernel
version. These fields describe the client running the renderer, not its selected
remote machine.

Central API failures carry the HTTP method, an allowlisted route template,
the allowlisted machine RPC method when applicable, elapsed milliseconds, and a
bounded summary of error names, network/TLS error codes, and allowlisted system
calls (`connect`, `read`, `write`, `getaddrinfo`, `getnameinfo`, `shutdown`) from nested causes
and aggregate connection failures. The transport captures the request's caller
stack before awaiting fetch; local filenames in the serialized stack are reduced
to `app:///` basenames. Hostnames, resource IDs, query strings, headers, request
bodies, and raw nested-cause messages are not included in this diagnostic context.
Unknown routes or cause codes do not expand the collection automatically.
Diagnostics distinguish `network`, `timeout`, `cancelled`, `http`, and `decode`,
identify `node_fetch` or `browser_fetch`, record whether the failure occurred
during `fetch` or `response_body`, and include HTTP status when a response exists.
HTTP errors also retain allowlisted API error codes in `central.api_error_code`
and `central_request.api_error_code`, including `machine_offline`, `daemon_timeout`,
`daemon_error`, and `turn_service_unavailable`, plus the fixed core API codes.
Unknown response codes are omitted. The code survives Electron IPC without
exporting response bodies, and does not change existing issue fingerprints.
A non-JSON HTTP error retains its HTTP status; malformed successful JSON is a
decoding failure. Response-body connection failures retain their transport cause.
The shared Ky transport normalizes failures only after its configured recovery
attempts finish. Intermediate retries do not produce separate error reports.
Ky network errors retain their original runtime cause; timeout messages omit the
request URL. Local HTTP errors retain response headers for credential checks,
but the Response object never enters the serialized diagnostic envelope.

The main process returns a plain success/error envelope through Electron IPC and
the preload context bridge. The renderer reconstructs the diagnostic Error,
reports it once, then rejects the caller's promise with that same Error. This
retains diagnostics for UI-handled failures and lets the SDK avoid a second event
if the error later reaches an unhandled rejection hook. The existing displayed
error message is preserved. Sentry titles instead identify the method, route, RPC,
and sorted cause codes, for example `GET /api/teams/:teamId/machines — ECONNRESET`.
Fingerprints use the transport, method, route, RPC, and sorted cause codes without
Sentry's default stack fingerprint. Different platform bundles therefore group
the same operation together while preserving their original stacks and OS/release
tags. Kind and phase are also part of grouping, so an interrupted response body
does not group with a failure before the response. The same enrichment applies
to unhandled central request errors.

`reportingCentral` observes the public API promise after internal recovery has
completed. The Web adapter uses it around its HTTP client; the desktop adapter
uses it after reconstructing IPC errors. Expired-login recovery therefore does
not generate an error event. Handled HTTP 4xx other than 429 remain with their UI
handlers; unhandled HTTP errors are enriched normally. Caller cancellations are
excluded from both paths, while deadlines still report as timeouts. HTTP status,
codes, and recovery reasons remain on the existing Web `HttpError`; desktop keeps
its existing displayed error shape and carries HTTP status in diagnostic context.
This reporting path does not retry requests or change proxy/network selection.

### Request attribution and background repetition

`withCentralRequestTrigger` creates immutable API views with `user`, `background`,
or `unknown` attribution; concurrent requests do not share mutable trigger state.
Automatic account/startup/reconnect loads, GitHub status polling, pinned-session
metadata, scheduled-task polling, and session-read acknowledgements opt into
`background`. Account actions, machine/workspace/provider/session mutations,
terminal actions, and manual scheduled-task refreshes opt into `user`. Calls that
can serve both automatic and interactive reads keep `unknown`; a GET or RPC name
alone does not establish that a request runs in the background.

Only handled background network/timeouts, HTTP 429, and HTTP 5xx are collapsed.
The first error is sent immediately. Matching failures within the next minute
increment a counter; a timer sends their summary even if the burst has stopped.
The key uses the bounded operation/cause fingerprint, allowlisted API error code, and visibility state,
without machine, team, or session IDs. This keeps hidden and visible failures in
separate summaries even though they belong to the same Sentry issue. Each renderer owns at most 128 active
buckets; eviction, `pagehide`, and SDK shutdown flush pending counts. Account
identity changes flush pending summaries before binding the new identity. No request
retry or UI error is suppressed. Browser termination and network loss can still
prevent best-effort delivery.

Events carry `request_repetition.occurrences` (1 for an individual event; the
number of suppressed repeats for a summary), `window_ms`, and `summary`.
`central.report_type` distinguishes `occurrence` and `summary`. Sum the occurrence
field to count handled failures; Sentry's event count now counts reports, not
requests. Unhandled errors bypass this reduction. User/unknown requests and
decoding failures are individually reported, including consecutive identical
stacks. Sentry's same-Error guard still prevents a captured rejection from being
reported again by its global handler.

`central.trigger`, `central.online`, and `central.visibility` are searchable tags.
The renderer samples the browser's online boolean and visible/hidden state when
the operation fails; these are hints, not proof of server reachability. No IP,
hostname, proxy URL, network name, or raw socket data is collected.

Handled background network failures and timeouts observed while hidden are sent
at warning level, including their summaries. Other failures, including HTTP 5xx,
user-initiated and unknown-trigger requests, stay at error level. Configure Sentry
alerts to match event level `error` for the primary alert and inspect warnings
separately. Filter events by `central.trigger:background` and
`central.visibility:hidden` when investigating background noise; a shared issue
can contain both warning and error events. This changes reporting only, not UI
errors, retries, or request execution. A hidden state does not prove that a
failure was caused by backgrounding.

The integration does not enable tracing, profiling, session replay, or log
capture. It does not attach component props, breadcrumbs, other profile fields, or
request/page data. Exception messages and stack traces remain useful diagnostic
data and can themselves contain application data; avoid putting credentials or
user content in thrown errors.

Electron adds only the configured DSN's origin to its renderer `connect-src`
policy. Without Sentry or Statsig, production retains `connect-src 'none'`.
Independent Web hosts must allow the DSN origin in their own `connect-src`
policy.

## Source maps

Tagged release builds generate hidden JavaScript source maps with
`DESKFLEET_SOURCEMAPS=1`. After both builds, `scripts/sentry-sourcemaps.ts`
uploads Web, Electron main, and Electron renderer maps with the pinned Sentry CLI.
It uses release/distribution matching because main-process stacks cross IPC and
cannot use debug IDs registered only in the renderer's JavaScript realm.
The upload prefixes are `~/` for Web, `app:///` for the sanitized main-process
basenames, and `deskfleet-app://bundle/` for renderer assets. The CLI associates
hidden maps using artifact source-map headers; deployed JavaScript is unchanged.

Configure `SENTRY_ORG`, `SENTRY_PROJECT`, and the `SENTRY_AUTH_TOKEN` secret in
GitHub's `production` environment when a DSN is enabled. The token needs source-map
upload access; it is exposed only to the upload step, never to Vite. Optional
`SENTRY_URL` selects a self-hosted instance. Uploads validate maps and wait for
processing; missing credentials, missing maps, or a failed upload fail the release.
An absent/invalid DSN skips upload. The script removes maps before the Web image
and artifacts are packaged, including when reporting is disabled. Electron's
packaging rules also exclude `.map` files. PR and main builds do not upload maps.

For a delivery check, build with a test project's DSN and trigger a test error
in the Web or Electron renderer. Confirm its platform, environment, and release
in that Sentry project. While signed in, confirm `user.id` and `user.email`;
after sign-out, confirm that new reports have no user identity.

SDK reference: [Sentry for Vue](https://docs.sentry.io/platforms/javascript/guides/vue/).
