import { vi } from "vitest"
import type { AdminTeamBilling, TeamBilling } from "../../../client/src/billing.ts"
import type { AiUsageQuery, TeamAiUsage, TeamAiUsageSessions } from "../../../client/src/ai-usage.ts"
import type { CentralApi, CentralEvent, LocalEnrollment, Machine, SiteSettings, Team, TeamMember } from "../../../client/src/central.ts"

export function billingFixture(usage = { relayedBytes: "0", activeSessionCount: 0, memberCount: 1 }): TeamBilling {
  return { plan: "selfHosted", limits: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: null }, usage, period: null, nextResetAt: null, enterpriseOverride: false, subscription: null, paymentsAvailable: false, canManageBilling: false, enterpriseContactEmail: null }
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
    signedIn: options.signedIn ?? true,
    siteAdmin: options.siteAdmin ?? false,
    site: { siteName: "DeskFleet", announcement: "", allowTeamCreation: true, termsOfServiceUrl: "", privacyTermsUrl: "", ...options.site },
    teams: options.teams ?? [{ id: "team-1", name: "Design team", role: "admin" as const }],
    machines: options.machines ?? [],
    members: options.members ?? [
      { userId: "user-1", name: "Ada", email: "ada@example.test", role: "admin" as const },
      { userId: "user-2", name: "Bob", email: "bob@example.test", role: "member" as const },
    ],
    enrollment: options.enrollment,
  }
  const status = () => ({ serverUrl: "https://fleet.example", siteAdmin: state.signedIn && state.siteAdmin, user: state.signedIn ? { id: "user-1", name: "Ada", email: "ada@example.test" } : undefined })
  const central = {
    status: vi.fn(async () => status()),
    login: vi.fn(async () => { state.signedIn = true }),
    logout: vi.fn(async () => { state.signedIn = false }),
    site: vi.fn(async () => ({ ...state.site })),
    siteSettings: vi.fn(async () => ({ ...state.site })),
    updateSiteSettings: vi.fn(async (settings: SiteSettings) => { state.site = { ...settings }; return { ...state.site } }),
    openAccountSettings: vi.fn(async () => {}),
    billing: vi.fn(async (_teamId: string) => billingFixture({ relayedBytes: "0", activeSessionCount: 0, memberCount: state.members.length })),
    checkout: vi.fn(async (_teamId: string, _plan: "go" | "pro", _requestId: string, _interval?: "month" | "year") => {}),
    billingPortal: vi.fn(async (_teamId: string) => {}),
    billingTeams: vi.fn(async (): Promise<AdminTeamBilling[]> => []),
    setEnterprise: vi.fn(async (_teamId: string, _enabled: boolean) => {}),
    registrationPolicy: vi.fn(async () => ({ registrationEnabled: true })),
    updateRegistration: vi.fn(async (_enabled: boolean) => {}),
    users: vi.fn(async (_query: string) => []),
    disableUser: vi.fn(async (_userId: string, _disabled: boolean) => {}),
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
    renameTeam: vi.fn(async (teamId: string, name: string) => {
      const team = state.teams.find(value => value.id === teamId)!
      team.name = name
      return { ...team }
    }),
    members: vi.fn(async (_teamId: string) => state.members.map(member => ({ ...member }))),
    teamUsage: vi.fn(async (_teamId: string) => ({ relayedBytes: "0", activeSessionCount: 0, memberCount: state.members.length })),
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
    renameMachine: vi.fn(async (machineId: string, name: string) => {
      const machine = state.machines.find(value => value.id === machineId)!
      machine.name = name.trim()
      return { ...machine }
    }),
    removeMachine: vi.fn(async (machineId: string) => {
      state.machines = state.machines.filter(machine => machine.id !== machineId)
      if (state.enrollment?.machineId === machineId) state.enrollment = { ...state.enrollment, revoked: true }
    }),
    enrollHeadless: vi.fn(async (teamId: string, input: { name: string; originId: string; localMachineId: string }) => {
      const machine = { ...machineFixture(`machine-${state.machines.length + 1}`, teamId, input.name, false), originId: input.originId, lastSeenAt: null }
      state.machines.push(machine)
      return { machine: { ...machine }, token: "machine-token" }
    }),
    ...(state.enrollment ? {
      localEnrollment: vi.fn(async () => ({ ...state.enrollment! })),
      enrollLocal: vi.fn(async (teamId: string, name?: string) => {
        const machine = machineFixture(`local-${state.machines.length + 1}`, teamId, name || state.enrollment!.machineName)
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
