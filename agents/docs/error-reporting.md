# Optional frontend error reporting

Web and Electron renderers use `@sentry/vue` through the shared Vue frontend.
Sentry captures Vue errors, uncaught JavaScript errors, and unhandled promise
rejections. The integration covers authentication, the root application, and
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

PR, main, and manual Build runs do not bind the production environment and leave
Sentry disabled. Keep production values out of repository and organization
variables. See [release configuration](ci.md#tagged-releases) for the
environment's tag restrictions.

## Collection and delivery

Reporting is independent of Statsig. A missing or invalid DSN leaves the Sentry
client uninitialized. With a configured DSN, delivery is best effort; the app
does not wait for a Sentry server before becoming usable.

The integration does not enable tracing, profiling, session replay, or log
capture. It does not attach component props, breadcrumbs, user identity, or
request/page data. Exception messages and stack traces remain useful diagnostic
data and can themselves contain application data; avoid putting credentials or
user content in thrown errors.

Electron adds only the configured DSN's origin to its renderer `connect-src`
policy. Without Sentry or Statsig, production retains `connect-src 'none'`.
Independent Web hosts must allow the DSN origin in their own `connect-src`
policy. No Sentry authentication token or source-map upload is part of the
build. Release identifiers label events; they do not upload source maps.

For a delivery check, build with a test project's DSN and trigger a test error
in the Web or Electron renderer. Confirm its platform, environment, and release
in that Sentry project.

SDK reference: [Sentry for Vue](https://docs.sentry.io/platforms/javascript/guides/vue/).
