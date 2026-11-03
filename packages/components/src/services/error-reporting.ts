import { attachErrorHandler, browserApiErrorsIntegration, captureException, dedupeIntegration, eventFiltersIntegration, globalHandlersIntegration, init, setUser, type ErrorEvent } from "@sentry/vue"
import type { App } from "vue"
import type { AccountUser, CentralApi } from "@deskfleet/client/central"
import type { DesktopErrorReportingContext } from "@deskfleet/client/error-reporting-context"
import { CentralRequestError } from "@deskfleet/client/request-diagnostics"
import { parseSentryDsn } from "@deskfleet/client/sentry-config"

// One SDK per document, including the independently mounted MachineSurface apps.
let client: ReturnType<typeof init>
const installed = new WeakSet<App>()

function prepareError(event: ErrorEvent): ErrorEvent {
  // Authentication URLs and application state are not error-reporting context.
  delete event.request
  // Keep the account identity captured with the error, limited to ID and email.
  if (event.user?.id) {
    const { id, email } = event.user
    event.user = { id, ...(email ? { email } : {}) }
  } else delete event.user
  delete event.breadcrumbs
  delete event.extra
  for (const exception of event.exception?.values ?? []) {
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = frame.filename.split(/[?#]/, 1)[0]
    }
  }
  return event
}

/** Initialize before loading the application; an absent DSN leaves no SDK hooks. */
export function initializeErrorReporting(platform: "web" | "desktop", context?: DesktopErrorReportingContext): void {
  const configuration = parseSentryDsn(import.meta.env.VITE_SENTRY_DSN)
  if (client || !configuration) return
  client = init({
    dsn: configuration.dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE?.trim() || undefined,
    initialScope: {
      tags: { platform },
      ...(context ? { contexts: {
        os: context.os,
        device: { arch: context.architecture },
        app: { app_version: context.appVersion },
        runtime: { name: "Electron", version: context.electronVersion },
        node: { name: "Node.js", version: context.nodeVersion },
        browser: { name: "Chrome", version: context.chromeVersion },
      } } : {}),
    },
    // Explicit error-only integrations omit URL, DOM, console and session collection.
    defaultIntegrations: false,
    integrations: [eventFiltersIntegration(), browserApiErrorsIntegration(), globalHandlersIntegration(), dedupeIntegration()],
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    maxBreadcrumbs: 0,
    sendClientReports: false,
    beforeSend: prepareError,
  })
}

/** Bind the authenticated account without collecting other profile fields. */
export function setErrorReportingUser(user?: Pick<AccountUser, "id" | "email">): void {
  if (!client) return
  setUser(user ? { id: user.id, ...(user.email ? { email: user.email } : {}) } : null)
}

/** Report handled transport failures while the original, bounded diagnostics still exist. */
export function captureCentralRequestError(error: unknown): void {
  if (!client || !(error instanceof CentralRequestError)) return
  const { method, route, rpcMethod, elapsedMs, causes } = error.diagnostics
  const code = causes.find(cause => cause.code)?.code
  const codes = [...new Set(causes.flatMap(cause => cause.code ? [cause.code] : []))].sort()
  captureException(error, {
    fingerprint: ["{{ default }}", method, route, rpcMethod ?? "", codes.join(",") || "unknown"],
    tags: {
      "central.method": method,
      "central.route": route,
      ...(rpcMethod ? { "central.rpc_method": rpcMethod } : {}),
      ...(code ? { "central.cause_code": code } : {}),
    },
    // Keep causes within the SDK's normalization depth so their codes remain visible.
    contexts: { central_request: {
      method, route, rpc_method: rpcMethod, elapsed_ms: elapsedMs,
      causes: causes.map(cause => cause.code ? `${cause.name}: ${cause.code}` : cause.name),
    } },
  })
}

/** Attach each Vue app without starting another SDK or collecting component props. */
export function installErrorReporting(app: App): void {
  if (!client || installed.has(app)) return
  installed.add(app)
  attachErrorHandler(app, { attachProps: false })
}

/** Standalone preview documents have no account owner to supply reactive identity. */
export function installErrorReportingAccount(app: App, central: Pick<CentralApi, "status" | "onEvent">): void {
  if (!client) return
  let revision = 0
  async function refresh(): Promise<void> {
    const current = ++revision
    try {
      const { user } = await central.status()
      if (current === revision) setErrorReportingUser(user)
    } catch { /* Reporting identity must not prevent the preview from opening. */ }
  }
  const stop = central.onEvent(event => {
    if (event.type === "accountChanged") {
      setErrorReportingUser()
      void refresh()
    } else if (event.type === "connection" && event.connected) void refresh()
  })
  void refresh()
  app.onUnmount(() => { ++revision; stop(); setErrorReportingUser() })
}

export async function shutdownErrorReporting(): Promise<void> {
  const previous = client
  setErrorReportingUser()
  client = undefined
  await previous?.close(2000)
}

if (import.meta.hot) import.meta.hot.dispose(() => { void shutdownErrorReporting() })
