// Throwaway visual harness: a fake control plane for screenshotting account UI states.
import { configureClient } from "@deskfleet/client/platform"
import type { CentralApi, CentralEvent, Machine, TeamMember } from "@deskfleet/client/central"
import "virtual:uno.css"

const state = new URLSearchParams(location.search).get("state") ?? "machines"
let signedIn = state !== "signedOut"
const teams = state === "noTeams" ? [] : [{ id: "7", name: "Acme Platform", role: "admin" as const }, { id: "8", name: "Side project", role: "member" as const }]
const machines: Machine[] = state === "machines" ? [
  { id: "101", teamId: "7", name: "build-server-01", localMachineId: "1", originId: "o1", online: true, capabilities: {}, lastSeenAt: "2026-10-25T08:00:00Z" },
  { id: "102", teamId: "7", name: "Delton’s MacBook Pro", localMachineId: "1", originId: "o2", online: false, capabilities: {}, lastSeenAt: "2026-10-24T18:12:00Z" },
] : []
const members: TeamMember[] = [
  { userId: "u1", name: "Ada Lovelace", email: "ada@acme.dev", role: "admin" },
  { userId: "u2", name: "Grace Hopper", email: "grace@acme.dev", role: "member" },
  { userId: "u3", name: "Linus Pauling", email: null, role: "member" },
]
const listeners = new Set<(event: CentralEvent) => void>()
const delay = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 50))
const central = {
  status: async () => ({ serverUrl: "https://fleet.acme.dev", user: signedIn ? { id: "u1", name: "Ada Lovelace", email: "ada@acme.dev" } : undefined }),
  setServer: async () => ({ serverUrl: "https://fleet.acme.dev" }),
  login: async () => { signedIn = true }, logout: async () => { signedIn = false },
  teams: async () => delay(teams),
  createTeam: async (name: string) => { const team = { id: String(Date.now()), name, role: "admin" as const }; teams.push(team); return team },
  renameTeam: async (id: string, name: string) => { const team = teams.find(team => team.id === id)!; team.name = name; return team },
  members: async () => delay(members),
  invite: async () => ({ token: "dfi_9f3a1c7e2b8d4f60a1e5c9b7d3f2a8e4", expiresAt: "2026-11-01T08:00:00Z" }),
  acceptInvite: async () => teams[0]!,
  setMemberRole: async (_team: string, userId: string, role: "admin" | "member") => { members.find(member => member.userId === userId)!.role = role },
  removeMember: async (_team: string, userId: string) => { members.splice(members.findIndex(member => member.userId === userId), 1) },
  machines: async (teamId: string) => delay(machines.filter(machine => machine.teamId === teamId)),
  renameMachine: async (id: string, name: string) => { const machine = machines.find(value => value.id === id)!; machine.name = name; return machine },
  removeMachine: async (id: string) => { machines.splice(machines.findIndex(machine => machine.id === id), 1) },
  enrollHeadless: async (teamId: string, input: { name: string }) => ({ machine: { ...machines[0]!, id: "103", teamId, name: input.name }, token: "dfm_7c1e9a3f5b2d8e4a6c0f1b3d5e7a9c2f" }),
  localEnrollment: async () => ({ configured: false, connected: false, revoked: false, identity: { originId: "o9", machineId: "1" }, machineName: "This Mac" }),
  enrollLocal: async (teamId: string, name?: string) => ({ configured: true, connected: true, revoked: false, teamId, serverUrl: "https://fleet.acme.dev", machineId: "109", identity: { originId: "o9", machineId: "1" }, machineName: "This Mac" }),
  catalog: async (machineId: string) => ({ machineId, lastObservedAt: "2026-10-25T08:00:00Z", snapshot: { teamId: "7", machineId, machineName: machines.find(machine => machine.id === machineId)?.name ?? "x", workspaces: [{ id: "20", name: "storefront", worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code/web" }] }] }] } }),
  sessions: async () => [], session: async () => { throw new Error("none") }, events: async () => ({ events: [], lastEventSeq: "0" }),
  rpc: async () => { throw new Error("Offline in preview") },
  createPeer: async () => { throw new Error("Offline in preview") }, offerPeer: async () => { throw new Error("x") }, startPeer: async () => {}, candidatePeer: async () => {}, closePeer: async () => {},
  onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
} as unknown as CentralApi
const unavailable = async (): Promise<never> => { throw new Error("Select a machine to continue") }
const subscribe = () => () => {}
const signaling = { offer: unavailable, candidate: unavailable, close: unavailable, onEvent: subscribe }
configureClient({
  platform: (new URLSearchParams(location.search).get("platform") ?? "web") as "web", locale: (new URLSearchParams(location.search).get("locale") ?? "en-US") as "en-US", central,
  settings: { get: async () => ({ enabled: false, status: "stopped" }), setLocalAgentEnabled: unavailable, getLaunchAtStartup: async () => ({ available: false, enabled: false }), setLaunchAtStartup: unavailable, onChanged: subscribe },
  catalog: { list: unavailable, createWorkspace: unavailable, updateWorkspace: unavailable, deleteWorkspace: unavailable, onChanged: subscribe },
  filesystem: { listDirectories: unavailable },
  providers: { list: unavailable, create: unavailable, update: unavailable, remove: unavailable, test: unavailable, onChanged: subscribe },
  agent: signaling,
  terminal: { ...signaling, list: unavailable, dial: unavailable, hangup: unavailable, onSessionEvent: subscribe },
  desktop: { ...signaling, target: unavailable, capabilities: unavailable, start: unavailable },
} as never)
const { mountDeskfleet } = await import("@deskfleet/components")
mountDeskfleet()
