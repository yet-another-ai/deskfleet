import { StatsigClient, type StatsigUser } from "@statsig/js-client"
import { computed, ref } from "vue"
import { STATSIG_INITIALIZE_URL, STATSIG_LOG_EVENT_URL } from "@deskfleet/client/analytics-config"
import type { BillingPlan } from "@deskfleet/client/billing"
import type { PeerTelemetryEvents } from "@deskfleet/client/peer-telemetry"
import type { BillingAnalyticsEvents } from "./billing-events.ts"
import type { EntitlementAnalyticsEvents } from "./entitlement-events.ts"

/** Explicit product events: never pass RPC payloads, user text, or resource paths. */
interface AnalyticsEvents extends BillingAnalyticsEvents, EntitlementAnalyticsEvents, PeerTelemetryEvents {
  app_opened: Record<string, never>
  page_viewed: { page: string }
  workspace_created: { directory_count: number }
  session_created: { context: "worktree" | "directory"; scope: "workspace" | "machine" }
  session_forked: { context: "worktree" | "directory" }
  session_archived: Record<string, never>
  session_restored: Record<string, never>
  input_submitted: { delivery: "backlog" | "steer" }
}

interface AnalyticsConfiguration {
  clientKey?: string
  environment: string
  platform: "web" | "desktop"
}

// One instance per renderer document, shared across the isolated MachineSurface apps.
let sdk: StatsigClient | undefined
let platform: AnalyticsConfiguration["platform"] = "web"
let userId: string | undefined
let team: { id: string; role: "admin" | "member" } | undefined
let plan: BillingPlan | undefined
let planRevision = 0
const revision = ref(0)

function user(): StatsigUser {
  return { ...(userId ? { userID: userId } : {}), ...(team ? { customIDs: { teamID: team.id } } : {}), custom: { platform } }
}

/** Starts in the background; product startup never waits for analytics. */
export function initializeAnalytics(configuration: AnalyticsConfiguration): void {
  const key = configuration.clientKey?.trim()
  if (sdk || !key) return
  platform = configuration.platform
  const instance = new StatsigClient(key, user(), {
    environment: { tier: configuration.environment },
    includeCurrentPageUrlWithEvents: false,
    networkConfig: {
      initializeUrl: STATSIG_INITIALIZE_URL,
      logEventUrl: STATSIG_LOG_EVENT_URL,
      initializeFallbackUrls: [],
      logEventFallbackUrls: [],
    },
  })
  sdk = instance
  instance.on("values_updated", () => { if (sdk === instance) revision.value++ })
  // The SDK handles ordinary network failures and cached/default evaluations.
  // A rejected initialization must also leave the application usable.
  void instance.initializeAsync({ timeoutMs: 1000 }).catch(() => {}).finally(() => {
    if (sdk === instance) revision.value++
  })
  revision.value++
}

/** Replace the identity on login/logout; never merge account name or email into it. */
export function identifyAnalytics(nextUserId?: string, nextTeam?: { id: string; role: "admin" | "member" }): void {
  if (!nextUserId) nextTeam = undefined
  if (userId === nextUserId && team?.id === nextTeam?.id && team?.role === nextTeam?.role) return
  planRevision++
  if (userId !== nextUserId || team?.id !== nextTeam?.id) plan = undefined
  userId = nextUserId
  team = nextTeam
  const instance = sdk
  if (!instance) return
  // updateUserAsync changes the SDK user synchronously before fetching its values.
  void instance.updateUserAsync(user(), { timeoutMs: 1000 }).catch(() => {}).finally(() => {
    if (sdk === instance) revision.value++
  })
  revision.value++
}

export function analyticsEnabled(): boolean { return sdk !== undefined }
export function analyticsTeamId(): string | undefined { return team?.id }

/** Share response ordering between account refresh and the Plans view. */
export function beginAnalyticsPlanRefresh(teamId: string): (value: BillingPlan) => void {
  if (team?.id !== teamId) return () => {}
  const revision = ++planRevision
  return value => { if (team?.id === teamId && revision === planRevision) plan = value }
}

export function trackEvent<Name extends keyof AnalyticsEvents>(name: Name, metadata: AnalyticsEvents[Name]): void {
  const context = team && name !== "team_join_action" ? { team_id: team.id, team_role: team.role, current_plan: plan ?? "unknown" } : {}
  sdk?.logEvent(name, undefined, Object.fromEntries(Object.entries({ ...context, ...metadata })
    .filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])))
}

/** Async action results belong to the account and Team that started the action. */
export function captureAnalyticsContext(): typeof trackEvent {
  const instance = sdk, actor = userId, teamId = team?.id
  return (name, metadata) => {
    if (sdk === instance && userId === actor && team?.id === teamId) trackEvent(name, metadata)
  }
}

export const analyticsReady = computed(() => {
  void revision.value
  return sdk?.loadingStatus === "Ready"
})

/** Read only where the feature is used: evaluation records a Statsig exposure. */
export function useFeatureGate(name: string) {
  return computed(() => {
    void revision.value
    return analyticsReady.value ? sdk!.checkGate(name) : false
  })
}

export function useExperimentParameter<T extends string | number | boolean>(name: string, parameter: string, fallback: T) {
  return computed(() => {
    void revision.value
    return analyticsReady.value ? sdk!.getExperiment(name).get(parameter, fallback) : fallback
  })
}

/** Root-app teardown only; switching machines keeps the same analytics instance. */
export async function shutdownAnalytics(): Promise<void> {
  const instance = sdk
  sdk = undefined
  userId = undefined
  team = undefined
  plan = undefined
  planRevision++
  revision.value++
  await instance?.shutdown().catch(() => {})
}

if (import.meta.hot) import.meta.hot.dispose(() => { void shutdownAnalytics() })
