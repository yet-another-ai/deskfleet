import { adminPlanQuotasFixture, creditRatesFixture, planCatalogFixture, quotaFixture } from "./plan-quotas.ts"
import { vi } from "vitest"
import type { CreditRates, HostedPlan, PlanQuota } from "@deskfleet/client/billing"
import type { AdminPlanQuota } from "@deskfleet/client/central"
import type { AdminTeamBillingPage, AdminTeamBillingQuery, TeamBilling } from "@deskfleet/client/billing"
import type { AccountDeletionRequestPage } from "@deskfleet/client/account-deletion"
import type { AiUsageQuery, TeamAiUsage, TeamAiUsageSessions } from "@deskfleet/client/ai-usage"
import type { RegisterSuperAgentMachineSessionInput, SuperAgentConfig, SuperAgentConfigUpdate, SuperAgentSession, SuperAgentUsage } from "@deskfleet/client/super-agent"
import type { SiteUsagePeriod, SiteUsageTrends } from "@deskfleet/client/site-usage"
import type { CentralApi, CentralEvent, LocalEnrollment, Machine, SiteSettings, TurnSettings, CloudflareTurnSettings, CloudflareTurnSettingsUpdate, Team, TeamMember, TeamTurnAvailability, TeamTurnSettingsUpdate } from "@deskfleet/client/central"

export function billingFixture(usage = { relayedBytes: "0", activeSessionCount: 0, memberCount: 1 }): TeamBilling {
  return { plan: "selfHosted", limits: quotaFixture.selfHosted, planCatalog: planCatalogFixture(), usage, period: null, nextResetAt: null, enterpriseOverride: false, subscription: null, paymentsAvailable: false, canManageBilling: false, enterpriseContactEmail: null }
}

export function aiUsageFixture(query: AiUsageQuery = { period: "30d", timeZone: "UTC" }): TeamAiUsage {
  return {
    ...query, from: "2026-09-29T00:00:00Z", to: "2026-10-28T12:00:00Z", lastSyncedAt: null,
    totals: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: null, cachedWriteTokens: null, thoughtTokens: null, turnCount: 0, reportedTurnCount: 0 },
    buckets: [], heatmap: [], models: [], members: [],
  }
}

export interface FakeCentralOptions {
  signedIn?: boolean
  siteAdmin?: boolean
  site?: Partial<SiteSettings>
  turn?: Partial<TurnSettings>
  cloudflareTurn?: Partial<CloudflareTurnSettings>
  /** The Team relay; its secret is kept in state but never returned. */
  teamTurn?: { availability?: TeamTurnAvailability; urls?: string[]; secret?: string }
  teams?: Team[]
  machines?: Machine[]
  members?: TeamMember[]
  /** Omit to model the Web client, which hosts no daemon. */
  enrollment?: LocalEnrollment
}

export function machineFixture(id: string, teamId: string, name: string, online = true): Machine {
  return { id, teamId, name, originId: `origin-${id}`, localMachineId: "1", online, capabilities: {}, lastSeenAt: "2026-10-24T18:00:00Z" }
}

/** An in-memory control plane: account, Team, membership, and enrollment calls change its state. */
export function fakeCentral(options: FakeCentralOptions = {}) {
  const listeners = new Set<(event: CentralEvent) => void>()
  const state = {
    planQuotas: adminPlanQuotasFixture(),
    creditRates: { ...creditRatesFixture },
    signedIn: options.signedIn ?? true,
    siteAdmin: options.siteAdmin ?? false,
    site: { siteName: "DeskFleet", announcement: "", allowTeamCreation: true, telemetryEnabled: false, termsOfServiceUrl: "", privacyTermsUrl: "", ...options.site },
    turn: { urls: [...(options.turn?.urls ?? [])], allowTeamServers: options.turn?.allowTeamServers ?? true },
    cloudflareTurn: { enabled: false, accountId: "", keyId: "", apiTokenConfigured: false, analyticsTokenConfigured: false, ...options.cloudflareTurn },
    teamTurn: { availability: options.teamTurn?.availability ?? "available" as TeamTurnAvailability, urls: [...(options.teamTurn?.urls ?? [])], secret: options.teamTurn?.secret },
    teams: options.teams ?? [{ id: "team-1", name: "Design team", role: "admin" as const }],
    machines: options.machines ?? [],
    members: options.members ?? [
      { userId: "user-1", name: "Ada", email: "ada@example.test", role: "admin" as const },
      { userId: "user-2", name: "Bob", email: "bob@example.test", role: "member" as const },
    ],
    enrollment: options.enrollment,
    superAgentConfig: { mode: "hosted", hostedConfigured: true, canConfigure: true, byoa: null } as SuperAgentConfig,
  }
  const status = () => ({ serverUrl: "https://fleet.example", siteAdmin: state.signedIn && state.siteAdmin, user: state.signedIn ? { id: "user-1", name: "Ada", email: "ada@example.test" } : undefined })
  const teamTurnSettings = () => ({ availability: state.teamTurn.availability, urls: [...state.teamTurn.urls], secretConfigured: state.teamTurn.secret !== undefined })
  const central = {
    status: vi.fn(async () => status()),
    login: vi.fn(async () => { state.signedIn = true }),
    logout: vi.fn(async () => { state.signedIn = false }),
    site: vi.fn(async () => ({ ...state.site })),
    updateTelemetryConsent: vi.fn(async () => {}),
    siteSettings: vi.fn(async () => ({ ...state.site })),
    creditRates: vi.fn(async () => ({ ...state.creditRates })),
    updateCreditRates: vi.fn(async (next: CreditRates) => { state.creditRates = { ...next }; return { ...next } }),
    planQuotas: vi.fn(async () => state.planQuotas.map(row => ({ ...row }))),
    updatePlanQuota: vi.fn(async (plan: HostedPlan, limits: PlanQuota): Promise<AdminPlanQuota> => {
      const updated = { plan, ...limits }
      state.planQuotas = state.planQuotas.map(row => row.plan === plan ? updated : row)
      return updated
    }),
    usageTrends: vi.fn(async (period: SiteUsagePeriod): Promise<SiteUsageTrends> => ({
      period, timeZone: "UTC", from: "2026-10-16T00:00:00Z", to: "2026-11-14T12:00:00Z", generatedAt: "2026-11-14T12:00:00Z",
      relayHistoryIncomplete: false, totals: { users: 2, teams: state.teams.length, machines: 0, sessions: 0 }, buckets: [],
    })),
    updateSiteSettings: vi.fn(async (settings: SiteSettings) => { state.site = { ...settings }; return { ...state.site } }),
    turnSettings: vi.fn(async () => ({ ...state.turn, urls: [...state.turn.urls] })),
    updateTurnSettings: vi.fn(async (settings: TurnSettings) => { state.turn = { ...settings, urls: [...settings.urls] }; return { ...state.turn, urls: [...state.turn.urls] } }),
    cloudflareTurnSettings: vi.fn(async () => ({ ...state.cloudflareTurn })),
    updateCloudflareTurnSettings: vi.fn(async (settings: CloudflareTurnSettingsUpdate) => {
      state.cloudflareTurn = {
        enabled: settings.enabled, accountId: settings.accountId, keyId: settings.keyId,
        apiTokenConfigured: settings.apiToken === undefined ? state.cloudflareTurn.apiTokenConfigured : settings.apiToken.length > 0,
        analyticsTokenConfigured: settings.analyticsToken === undefined ? state.cloudflareTurn.analyticsTokenConfigured : settings.analyticsToken.length > 0,
      }
      return { ...state.cloudflareTurn }
    }),
    openAccountSettings: vi.fn(async () => {}),
    githubSettings: vi.fn<CentralApi["githubSettings"]>(async () => ({ configured: false, manageUrl: null, authorized: false, login: null, actAsYou: false })),
    githubPullRequest: vi.fn<CentralApi["githubPullRequest"]>(async () => ({ pullRequest: null })),
    githubRepositoryItems: vi.fn<CentralApi["githubRepositoryItems"]>(async () => ({ items: [], nextCursor: null })),
    search: vi.fn<CentralApi["search"]>(async () => ({ results: [] })),
    scheduleSnapshot: vi.fn<CentralApi["scheduleSnapshot"]>(async () => ({ tasks: [], lastObservedAt: null })),
    manageGithub: vi.fn(async () => {}),
    authorizeGithubApp: vi.fn(async () => {}),
    setGithubActAsYou: vi.fn(async (actAsYou: boolean) => ({ configured: true, manageUrl: "https://github.com/apps/deskfleet/installations/new", authorized: true, login: "ada", actAsYou })),
    billing: vi.fn(async (_teamId: string) => billingFixture({ relayedBytes: "0", activeSessionCount: 0, memberCount: state.members.length })),
    checkout: vi.fn(async (_teamId: string, _plan: "go" | "pro", _requestId: string, _interval?: "month" | "year") => {}),
    billingPortal: vi.fn(async (_teamId: string) => {}),
    billingTeams: vi.fn(async (_query?: AdminTeamBillingQuery): Promise<AdminTeamBillingPage> => ({ teams: [], nextCursor: null })),
    setManualGrant: vi.fn(async (_teamId: string, _plan: "free" | "go" | "pro" | "enterprise" | null, _expiresAt: number | null, _reason: string) => {}),
    deletionRequests: vi.fn(async (): Promise<AccountDeletionRequestPage> => ({ requests: [], nextCursor: null })),
    reviewDeletionRequest: vi.fn(async (_id: string, _approve: boolean, _note?: string) => {}),
    registrationPolicy: vi.fn(async () => ({ registrationEnabled: true, captchaEnabled: false })),
    updateRegistration: vi.fn(async (_enabled: boolean) => {}),
    updateCaptcha: vi.fn(async (_enabled: boolean) => {}),
    users: vi.fn(async (_query: string) => []),
    createUser: vi.fn(async (input: { name: string; email: string; password: string }) => ({ id: "user-created", name: input.name, email: input.email, disabled: false })),
    disableUser: vi.fn(async (_userId: string, _disabled: boolean) => {}),
    sendEmailCode: vi.fn(async () => ({ challengeId: "challenge", expiresIn: 600, retryAfter: 60 })),
    verifyEmailCode: vi.fn(async () => {}),
    authenticationMethods: vi.fn(async () => ({ password: true, passkey: false })),
    reauthenticate: vi.fn(async (_password?: string) => {}),
    teams: vi.fn(async () => state.teams.map(team => ({ ...team }))),
    createTeam: vi.fn(async (name: string) => {
      const team = { id: `team-${state.teams.length + 1}`, name, role: "owner" as const }
      state.teams.push(team)
      return { ...team }
    }),
    acceptInvite: vi.fn(async (_code: string) => {
      const team = { id: "invited-team", name: "Invited team", role: "member" as const }
      state.teams.push(team)
      return { ...team }
    }),
    deleteTeam: vi.fn(async (teamId: string) => {
      state.teams = state.teams.filter(value => value.id !== teamId)
    }),
    renameTeam: vi.fn(async (teamId: string, name: string) => {
      const team = state.teams.find(value => value.id === teamId)!
      team.name = name
      return { ...team }
    }),
    members: vi.fn(async (_teamId: string) => state.members.map(member => ({ ...member }))),
    superAgentAvailability: vi.fn(async (_teamId: string) => ({ enabled: false })),
    superAgentConfig: vi.fn(async (_teamId: string): Promise<SuperAgentConfig> => ({ ...state.superAgentConfig, byoa: state.superAgentConfig.byoa ? { ...state.superAgentConfig.byoa } : null })),
    updateSuperAgentConfig: vi.fn(async (_teamId: string, update: SuperAgentConfigUpdate): Promise<SuperAgentConfig> => {
      const nextByoa = update.byoa === undefined
        ? state.superAgentConfig.byoa
        : update.byoa === null
          ? null
          : {
            machineId: update.byoa.machineId,
            machineName: state.machines.find(m => m.id === update.byoa!.machineId)?.name ?? update.byoa.machineId,
            machineOnline: state.machines.find(m => m.id === update.byoa!.machineId)?.online ?? true,
            providerId: update.byoa.providerId,
            providerName: update.byoa.providerName ?? null,
            cwd: update.byoa.cwd ?? null,
            yolo: !!update.byoa.yolo,
          }
      state.superAgentConfig = { ...state.superAgentConfig, mode: update.mode, byoa: nextByoa }
      return { ...state.superAgentConfig, byoa: nextByoa ? { ...nextByoa } : null }
    }),
    superAgentSessions: vi.fn(async (_teamId: string): Promise<SuperAgentSession[]> => []),
    registerSuperAgentMachineSession: vi.fn(async (_teamId: string, input: RegisterSuperAgentMachineSessionInput): Promise<SuperAgentSession> => ({
      sessionId: input.sessionId,
      title: input.title ?? null,
      lastActiveAt: input.lastActiveAt ?? Date.now(),
      engine: "byoa",
      machineId: input.machineId,
      machineName: state.machines.find(m => m.id === input.machineId)?.name ?? input.machineId,
      providerId: input.providerId,
      providerName: input.providerName ?? null,
    })),
    superAgentUsage: vi.fn(async (_teamId: string): Promise<SuperAgentUsage> => ({
      runtimeConfigured: true, admitted: true, usedCredits: "0", includedCredits: null, usedTokens: 0, includedTokens: null, plan: "selfHosted",
      start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z",
    })),
    createSuperAgentSession: vi.fn<CentralApi["createSuperAgentSession"]>(async (_teamId, operationId, message) => ({
      sessionId: `wrun_${operationId}`, ...(message === undefined ? {} : { deliveryId: `delivery_${operationId}` }),
    })),
    sendSuperAgentMessage: vi.fn<CentralApi["sendSuperAgentMessage"]>(async (_teamId, sessionId, operationId) => ({ sessionId, deliveryId: `delivery_${operationId}` })),
    cancelSuperAgentTurn: vi.fn<CentralApi["cancelSuperAgentTurn"]>(async () => {}),
    superAgentHistory: vi.fn<CentralApi["superAgentHistory"]>(async (_teamId, _sessionId, startIndex) => ({ messages: [], nextIndex: startIndex })),
    teamUsage: vi.fn(async (_teamId: string) => ({ relayedBytes: "0", activeSessionCount: 0, memberCount: state.members.length })),
    teamTurnSettings: vi.fn(async (_teamId: string) => teamTurnSettings()),
    updateTeamTurnSettings: vi.fn(async (_teamId: string, settings: TeamTurnSettingsUpdate) => {
      if (settings.urls.length === 0) state.teamTurn = { ...state.teamTurn, urls: [], secret: undefined }
      else if (state.teamTurn.availability !== "available") throw new Error("Your own TURN server requires a Pro or Enterprise plan")
      else if (settings.secret === undefined && state.teamTurn.secret === undefined) throw new Error("Enter the TURN shared secret")
      else state.teamTurn = { ...state.teamTurn, urls: [...settings.urls], secret: settings.secret ?? state.teamTurn.secret }
      return teamTurnSettings()
    }),
    aiUsage: vi.fn(async (_teamId: string, query: AiUsageQuery) => aiUsageFixture(query)),
    aiUsageSessions: vi.fn(async (_teamId: string, query: { date: string; timeZone: string }): Promise<TeamAiUsageSessions> => ({ ...query, sessions: [], truncated: false })),
    setMemberRole: vi.fn(async (_teamId: string, userId: string, role: "admin" | "member") => {
      state.members.find(member => member.userId === userId)!.role = role
    }),
    removeMember: vi.fn(async (_teamId: string, userId: string) => {
      state.members = state.members.filter(member => member.userId !== userId)
    }),
    transferOwnership: vi.fn(async (teamId: string, userId: string) => {
      state.teams.find(team => team.id === teamId)!.role = "admin"
      for (const member of state.members) {
        if (member.role === "owner") member.role = "admin"
        if (member.userId === userId) member.role = "owner"
      }
    }),
    invite: vi.fn(async (_teamId: string, _email: string, _role: "admin" | "member") => ({ token: "invitation-token", expiresAt: "2026-11-20T12:00:00Z" })),
    machines: vi.fn(async (teamId: string) => state.machines.filter(machine => machine.teamId === teamId).map(machine => ({ ...machine }))),
    renameMachine: vi.fn(async (teamId: string, machineId: string, name: string) => {
      const machine = state.machines.find(value => value.id === machineId && value.teamId === teamId)!
      machine.name = name.trim()
      return { ...machine }
    }),
    removeMachine: vi.fn(async (teamId: string, machineId: string) => {
      state.machines = state.machines.filter(machine => machine.id !== machineId || machine.teamId !== teamId)
      if (state.enrollment?.machineId === machineId) state.enrollment = { ...state.enrollment, revoked: true }
    }),
    enrollHeadless: vi.fn(async (teamId: string, input: { name: string; originId: string; localMachineId: string }) => {
      const machine = { ...machineFixture(`machine-${state.machines.length + 1}`, teamId, input.name, false), originId: input.originId, lastSeenAt: null }
      state.machines.push(machine)
      return { machine: { ...machine }, token: "machine-token" }
    }),
    ...(state.enrollment ? {
      localEnrollment: vi.fn(async () => ({ machineName: state.enrollment!.machineName, registrations: state.enrollment!.configured ? [{ ...state.enrollment! }] : [] })),
      enrollLocal: vi.fn(async (teamId: string, name?: string) => {
        const machine = machineFixture(state.enrollment!.machineId ?? `local-${state.machines.length + 1}`, teamId, name || state.enrollment!.machineName)
        state.machines.push(machine)
        state.enrollment = { ...state.enrollment!, configured: true, revoked: false, serverUrl: "https://fleet.example", teamId, machineId: machine.id }
        return { ...state.enrollment }
      }),
    } : {}),
    onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    central: central as typeof central & CentralApi,
    state,
    emit: (event: CentralEvent) => { for (const listener of listeners) listener(event) },
  }
}
