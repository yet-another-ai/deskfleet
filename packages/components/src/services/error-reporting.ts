import { attachErrorHandler, browserApiErrorsIntegration, dedupeIntegration, globalHandlersIntegration, init, type ErrorEvent } from "@sentry/vue"
import type { App } from "vue"
import { parseSentryDsn } from "@deskfleet/client/sentry-config"

// One SDK per document, including the independently mounted MachineSurface apps.
let client: ReturnType<typeof init>
const installed = new WeakSet<App>()

function prepareError(event: ErrorEvent): ErrorEvent {
  // Authentication URLs and application state are not error-reporting context.
  delete event.request
  delete event.user
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
export function initializeErrorReporting(platform: "web" | "desktop"): void {
  const configuration = parseSentryDsn(import.meta.env.VITE_SENTRY_DSN)
  if (client || !configuration) return
  client = init({
    dsn: configuration.dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE?.trim() || undefined,
    initialScope: { tags: { platform } },
    // Explicit error-only integrations omit URL, DOM, console and session collection.
    defaultIntegrations: false,
    integrations: [browserApiErrorsIntegration(), globalHandlersIntegration(), dedupeIntegration()],
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    maxBreadcrumbs: 0,
    sendClientReports: false,
    beforeSend: prepareError,
  })
}

/** Attach each Vue app without starting another SDK or collecting component props. */
export function installErrorReporting(app: App): void {
  if (!client || installed.has(app)) return
  installed.add(app)
  attachErrorHandler(app, { attachProps: false })
}

export async function shutdownErrorReporting(): Promise<void> {
  const previous = client
  client = undefined
  await previous?.close(2000)
}

if (import.meta.hot) import.meta.hot.dispose(() => { void shutdownErrorReporting() })
