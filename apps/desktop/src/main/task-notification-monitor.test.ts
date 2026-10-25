import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AccountState, CentralEvent, Machine, Team } from "@deskfleet/client/central"
import type { AgentElicitation, AgentPermission, AgentSnapshot, AgentTurn } from "../../../daemon/src/agent-protocol.ts"
import { TaskNotificationMonitor } from "./task-notification-monitor.ts"

const timestamp = "2026-10-25T10:00:00Z"
const watchStartedAt = "2026-10-25T09:59:59Z"
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse(watchStartedAt)) })
afterEach(() => { vi.restoreAllMocks() })
const team: Team = { id: "team", name: "Engineering", role: "member" }
const machine = (id: string): Machine => ({ id, teamId: team.id, name: id, originId: `origin-${id}`, localMachineId: "1", online: true, capabilities: {} })
function snapshot(id = "1", seq = 1): AgentSnapshot {
  return {
    session: { id, workspaceId: "1", provider: "codex", title: `Task ${id}`, context: "directory", lifecycle: "ready", archiveState: "active", lastEventSeq: String(seq), createdAt: timestamp, updatedAt: timestamp },
    turns: [], runs: [], inputs: [], permissions: [], elicitations: [],
  }
}
function turn(id: string, state: AgentTurn["state"] = "completed"): AgentTurn {
  return { id, sessionId: "1", initialInputId: "input", dispatchCommandId: "command", runGeneration: 1, state, startedAt: timestamp, endedAt: state === "completed" ? timestamp : undefined }
}
function question(id: string, state: AgentElicitation["state"] = "pending"): AgentElicitation {
  return {
    id, sessionId: "1", runGeneration: 1, state, createdAt: timestamp,
    request: { sessionId: "provider-session", mode: "form", message: "Choose an approach", requestedSchema: { type: "object", properties: {} } },
  }
}
function permission(id: string): AgentPermission {
  return { id, sessionId: "1", runGeneration: 1, state: "pending", createdAt: timestamp, request: { sessionId: "provider-session", toolCall: { toolCallId: "tool" }, options: [] } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setup(initial: AgentSnapshot[] = [snapshot()]) {
  const listeners = new Set<(event: CentralEvent) => void>()
  const state = {
    account: { serverUrl: "https://deskfleet.example", user: { id: "user", name: "Ada" } } as AccountState,
    teams: [team], machines: [machine("local"), machine("remote")],
    snapshots: new Map<string, AgentSnapshot[]>([["local", initial], ["remote", []]]),
  }
  const source = {
    status: vi.fn(async () => structuredClone(state.account)),
    teams: vi.fn(async () => structuredClone(state.teams)),
    machines: vi.fn(async (id: string) => structuredClone(state.machines.filter(value => value.teamId === id))),
    sessions: vi.fn(async (id: string) => structuredClone(state.snapshots.get(id) ?? [])),
    onEvent(listener: (event: CentralEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const notify = vi.fn()
  const onError = vi.fn()
  const monitor = new TaskNotificationMonitor(source, notify, onError)
  return {
    state, source, notify, onError, monitor,
    emit(event: CentralEvent) { for (const listener of listeners) listener(event) },
    async refresh(machineId = "local") {
      const count = source.sessions.mock.calls.length
      for (const listener of listeners) listener({ type: "catalogChanged", machineId })
      await vi.waitFor(() => expect(source.sessions.mock.calls.length).toBeGreaterThan(count))
    },
  }
}

test("initial history is a baseline; subsequent completed turns and pending questions notify once", async () => {
  const initial = snapshot()
  initial.turns = [turn("old"), turn("running", "running")]
  initial.elicitations = [question("old-question")]
  const f = setup([initial])
  await f.monitor.start()
  expect(f.notify).not.toHaveBeenCalled()

  const updated = snapshot("1", 2)
  updated.turns = [turn("old"), turn("running")]
  updated.elicitations = [question("old-question", "resolved"), question("new-question")]
  f.state.snapshots.set("local", [updated])
  await f.refresh()
  expect(f.notify.mock.calls.map(([notice]) => notice)).toEqual([
    { kind: "taskCompleted", machineId: "local", sessionId: "1", title: "Task 1" },
    { kind: "taskNeedsInput", machineId: "local", sessionId: "1", title: "Task 1" },
  ])
  await f.refresh()
  updated.session.lastEventSeq = "3"
  await f.refresh()
  expect(f.notify).toHaveBeenCalledTimes(2)
  f.monitor.close()
})

test("remote machines and new sessions notify without a renderer subscription", async () => {
  const f = setup()
  await f.monitor.start()
  const updated = snapshot("remote-task", 8)
  updated.turns = [turn("finished")]
  f.state.snapshots.set("remote", [updated])
  await f.refresh("remote")
  expect(f.notify).toHaveBeenCalledExactlyOnceWith({ kind: "taskCompleted", machineId: "remote", sessionId: "remote-task", title: "Task remote-task" })
  f.monitor.close()
})

test("resolved questions, cancellation, failures, and archived sessions do not notify", async () => {
  const f = setup()
  await f.monitor.start()
  const updated = snapshot("1", 2)
  updated.turns = [turn("cancelled", "cancelled"), turn("interrupted", "interrupted"), turn("failed", "failed")]
  updated.elicitations = [question("resolved", "resolved"), question("cancelled", "cancelled")]
  const archived = snapshot("archived", 2)
  archived.session.archiveState = "archived"
  archived.turns = [turn("archived-completion")]
  f.state.snapshots.set("local", [updated, archived])
  await f.refresh()
  expect(f.notify).not.toHaveBeenCalled()
  f.monitor.close()
})

test("pending tool approvals use the input category and have separate request identities", async () => {
  const f = setup()
  await f.monitor.start()
  const updated = snapshot("1", 2)
  updated.permissions = [permission("shared-id")]
  updated.elicitations = [question("shared-id")]
  f.state.snapshots.set("local", [updated])
  await f.refresh()
  expect(f.notify).toHaveBeenCalledTimes(2)
  expect(f.notify.mock.calls.every(([notice]) => notice.kind === "taskNeedsInput")).toBe(true)
  updated.session.lastEventSeq = "3"
  await f.refresh()
  expect(f.notify).toHaveBeenCalledTimes(2)
  f.monitor.close()
})

test("reconnection catches completed work without replaying delivered notices", async () => {
  const f = setup()
  await f.monitor.start()
  f.emit({ type: "connection", connected: false })
  const updated = snapshot("1", 2)
  updated.turns = [turn("completed-offline")]
  f.state.snapshots.set("local", [updated])
  f.emit({ type: "connection", connected: true })
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce())
  const calls = f.source.sessions.mock.calls.length
  f.emit({ type: "connection", connected: true })
  await vi.waitFor(() => expect(f.source.sessions.mock.calls.length).toBeGreaterThan(calls))
  expect(f.notify).toHaveBeenCalledOnce()
  f.monitor.close()
})

test("a newly discovered machine establishes its own baseline", async () => {
  const f = setup()
  await f.monitor.start()
  f.state.machines.push(machine("new-machine"))
  const existing = snapshot()
  existing.turns = [turn("old-completion")]
  f.state.snapshots.set("new-machine", [existing])
  f.emit({ type: "catalogChanged", machineId: "new-machine" })
  await vi.waitFor(() => expect(f.source.sessions).toHaveBeenCalledWith("new-machine"))
  expect(f.notify).not.toHaveBeenCalled()
  existing.session.lastEventSeq = "2"
  existing.turns.push(turn("new-completion"))
  await f.refresh("new-machine")
  expect(f.notify).toHaveBeenCalledExactlyOnceWith({ kind: "taskCompleted", machineId: "new-machine", sessionId: "1", title: "Task 1" })
  f.monitor.close()
})

test("late history after an empty machine baseline suppresses old events and keeps later transitions", async () => {
  const f = setup()
  await f.monitor.start()
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-25T11:00:00Z"))
  f.state.machines.push(machine("enrolled"))
  f.emit({ type: "machinesChanged", teamId: team.id })
  await vi.waitFor(() => expect(f.source.sessions).toHaveBeenCalledWith("enrolled"))

  const history = snapshot("existing-task", 10)
  history.turns = [turn("old-completion")]
  history.elicitations = [question("old-question")]
  history.permissions = [permission("old-approval")]
  f.state.snapshots.set("enrolled", [history])
  await f.refresh("enrolled")
  expect(f.notify).not.toHaveBeenCalled()

  history.session.lastEventSeq = "11"
  history.turns.push({ ...turn("new-completion"), endedAt: "2026-10-25T11:00:01Z" })
  history.elicitations.push({ ...question("new-question"), createdAt: "2026-10-25T11:00:01Z" })
  await f.refresh("enrolled")
  expect(f.notify.mock.calls.map(([notice]) => notice.kind)).toEqual(["taskCompleted", "taskNeedsInput"])
  await f.refresh("enrolled")
  expect(f.notify).toHaveBeenCalledTimes(2)
  f.monitor.close()
})

test("unseen sessions use completion and question times, preserving work after observation began", async () => {
  const f = setup()
  await f.monitor.start()
  const old = "2026-10-25T09:00:00Z"
  const lateSession = snapshot("unseen-task", 20)
  lateSession.session.createdAt = old
  lateSession.turns = [
    { ...turn("historical"), endedAt: old },
    { ...turn("recent"), startedAt: old, endedAt: timestamp },
  ]
  lateSession.elicitations = [{ ...question("historical-question"), createdAt: old }, question("recent-question")]
  lateSession.permissions = [{ ...permission("historical-approval"), createdAt: old }, permission("recent-approval")]
  f.state.snapshots.set("remote", [lateSession])
  await f.refresh("remote")
  expect(f.notify.mock.calls.map(([notice]) => notice.kind)).toEqual(["taskCompleted", "taskNeedsInput", "taskNeedsInput"])
  expect(f.notify.mock.calls.every(([notice]) => notice.machineId === "remote")).toBe(true)
  f.monitor.close()
})

test("logout invalidates an in-flight task read and another account starts from a fresh baseline", async () => {
  const f = setup()
  await f.monitor.start()
  const read = deferred<AgentSnapshot[]>()
  f.source.sessions.mockImplementationOnce(() => read.promise)
  f.emit({ type: "catalogChanged", machineId: "local" })
  const updated = snapshot("1", 2)
  updated.turns = [turn("old-account-completion")]
  f.state.account = { serverUrl: "https://deskfleet.example" }
  f.emit({ type: "accountChanged" })
  read.resolve([updated])
  await vi.waitFor(() => expect(f.source.status).toHaveBeenCalledTimes(2))
  expect(f.notify).not.toHaveBeenCalled()

  f.state.account = { serverUrl: "https://other.example", user: { id: "other-user", name: "Bob" } }
  f.state.snapshots.set("local", [updated])
  const calls = f.source.sessions.mock.calls.length
  f.emit({ type: "accountChanged" })
  await vi.waitFor(() => expect(f.source.sessions.mock.calls.length).toBeGreaterThan(calls))
  expect(f.notify).not.toHaveBeenCalled()
  updated.session.lastEventSeq = "3"
  updated.turns.push(turn("new-account-completion"))
  await f.refresh()
  expect(f.notify).toHaveBeenCalledOnce()
  f.monitor.close()
})

test("a change received during a snapshot read schedules another read", async () => {
  const f = setup()
  await f.monitor.start()
  const read = deferred<AgentSnapshot[]>()
  f.source.sessions.mockImplementationOnce(() => read.promise)
  f.emit({ type: "catalogChanged", machineId: "local" })
  const updated = snapshot("1", 3)
  updated.turns = [turn("after-read")]
  f.state.snapshots.set("local", [updated])
  f.emit({ type: "catalogChanged", machineId: "local" })
  read.resolve([snapshot("1", 2)])
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce())
  expect(f.source.sessions.mock.calls.filter(([id]) => id === "local")).toHaveLength(3)
  f.monitor.close()
})

test("failed reads preserve the baseline and retry on the next event", async () => {
  const f = setup()
  await f.monitor.start()
  const error = new Error("Server unavailable")
  f.source.sessions.mockRejectedValueOnce(error)
  await f.refresh()
  expect(f.onError).toHaveBeenCalledWith(error)
  const updated = snapshot("1", 2)
  updated.turns = [turn("after-error")]
  f.state.snapshots.set("local", [updated])
  await f.refresh()
  expect(f.notify).toHaveBeenCalledOnce()
  f.monitor.close()
})

test("removed machines stop being observed and closing discards pending reads", async () => {
  const f = setup()
  await f.monitor.start()
  f.state.machines = [machine("local")]
  f.emit({ type: "machinesChanged", teamId: team.id })
  await vi.waitFor(() => expect(f.source.machines).toHaveBeenCalledTimes(2))
  const remoteCalls = f.source.sessions.mock.calls.filter(([id]) => id === "remote").length
  f.emit({ type: "catalogChanged", machineId: "remote" })
  await vi.waitFor(() => expect(f.source.machines).toHaveBeenCalledTimes(3))
  expect(f.source.sessions.mock.calls.filter(([id]) => id === "remote")).toHaveLength(remoteCalls)

  const read = deferred<AgentSnapshot[]>()
  f.source.sessions.mockImplementationOnce(() => read.promise)
  f.emit({ type: "catalogChanged", machineId: "local" })
  f.monitor.close()
  const updated = snapshot("1", 2)
  updated.turns = [turn("after-close")]
  read.resolve([updated])
  await f.monitor.start()
  expect(f.notify).not.toHaveBeenCalled()
})
