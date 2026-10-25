import { client as platformClient } from "@deskfleet/client/platform"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { TerminalSessionEvent, TerminalSummary } from "../../../client/src/terminal.ts"
import { TerminalClient } from "../services/terminal-client.ts"
import { useTerminalsStore } from "./terminals.ts"
import { deferred } from "../test/desktop-media.ts"

const shell: TerminalSummary = { id: "shell-1", title: "home", cwd: "/home/user", cols: 80, rows: 24, status: "running" }
const stores: ReturnType<typeof useTerminalsStore>[] = []
let receive: (event: TerminalSessionEvent) => void

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(platformClient.terminal, "onSessionEvent").mockImplementation((listener) => {
    receive = listener
    return () => {}
  })
})
afterEach(() => {
  for (const store of stores.splice(0)) store.$dispose()
  vi.restoreAllMocks()
})

function setup() {
  const store = useTerminalsStore()
  stores.push(store)
  return store
}

test("lists, dials and hangs up shells through signaling without needing a data peer", async () => {
  const list = vi.spyOn(platformClient.terminal, "list").mockResolvedValue([shell])
  const dial = vi.spyOn(platformClient.terminal, "dial").mockImplementation(async (options) => ({ ...shell, id: options.terminalId }))
  const hangup = vi.spyOn(platformClient.terminal, "hangup").mockResolvedValue()
  const offer = vi.spyOn(platformClient.terminal, "offer")
  const store = setup()
  await store.refresh()
  expect(list).toHaveBeenCalledOnce()
  expect(store.sessions).toEqual([shell])
  const created = await store.create({ cols: 100, rows: 40 })
  expect(dial).toHaveBeenCalledWith({ mode: "create", terminalId: created.id, cols: 100, rows: 40 })
  const owned = await store.create({ worktreeId: "31" })
  expect(dial).toHaveBeenLastCalledWith({ mode: "create", terminalId: owned.id, cols: 80, rows: 24, worktreeId: "31" })
  expect(store.selected["31"]).toBe(owned.id)
  await store.hangup(owned.id)
  expect(created.id).not.toBe(shell.id)
  await store.hangup(created.id)
  expect(hangup).toHaveBeenCalledWith(created.id)
  expect(store.sessions).toEqual([shell])
  expect(offer).not.toHaveBeenCalled()
})

test("catalog changes from another client update and remove only the matching shell", () => {
  const store = setup()
  receive({ kind: "terminalChanged", terminal: shell })
  receive({ kind: "terminalChanged", terminal: { ...shell, id: "shell-2" } })
  receive({ kind: "terminalChanged", terminal: { ...shell, status: "interrupted" } })
  expect(store.sessions.map(({ id, status }) => [id, status])).toEqual([["shell-1", "interrupted"], ["shell-2", "running"]])
  receive({ kind: "terminalHungup", terminalId: "shell-1" })
  expect(store.sessions.map(({ id }) => id)).toEqual(["shell-2"])
})

test("opening an empty panel first discovers existing shells and shares pending creation on reopen", async () => {
  const listed = deferred<TerminalSummary[]>()
  const list = vi.spyOn(platformClient.terminal, "list").mockReturnValueOnce(listed.promise).mockResolvedValue([])
  const created = deferred<TerminalSummary>()
  const dial = vi.spyOn(platformClient.terminal, "dial").mockReturnValue(created.promise)
  const store = setup()
  const opening = store.ensureWorktreeTerminal("31")
  expect(dial).not.toHaveBeenCalled()
  listed.resolve([{ ...shell, worktreeId: "31" }])
  await expect(opening).resolves.toMatchObject({ id: shell.id })
  expect(dial).not.toHaveBeenCalled()

  const first = store.ensureWorktreeTerminal("32")
  await vi.waitFor(() => expect(dial).toHaveBeenCalledOnce())
  const reopened = store.ensureWorktreeTerminal("32")
  created.resolve({ ...shell, id: "new-shell", worktreeId: "32" })
  await expect(first).resolves.toMatchObject({ id: "new-shell" })
  await expect(reopened).resolves.toMatchObject({ id: "new-shell" })
  expect(dial).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId: "32" }))
  expect(list).toHaveBeenCalledTimes(2)
})

test("an unavailable terminal list leaves panel creation retryable without spawning a duplicate", async () => {
  const list = vi.spyOn(platformClient.terminal, "list").mockRejectedValue(new Error("Daemon unavailable"))
  const dial = vi.spyOn(platformClient.terminal, "dial")
  const store = setup()
  await expect(store.ensureWorktreeTerminal("31")).rejects.toThrow("Daemon unavailable")
  expect(dial).not.toHaveBeenCalled()
  list.mockResolvedValue([{ ...shell, worktreeId: "31" }])
  await expect(store.ensureWorktreeTerminal("31")).resolves.toMatchObject({ id: shell.id })
  expect(dial).not.toHaveBeenCalled()
})

test("a shell announced during a shared list request prevents automatic duplicate creation", async () => {
  const listed = deferred<TerminalSummary[]>()
  const list = vi.spyOn(platformClient.terminal, "list").mockReturnValue(listed.promise)
  const dial = vi.spyOn(platformClient.terminal, "dial")
  const store = setup()
  const refreshing = store.refresh()
  const opening = store.ensureWorktreeTerminal("31")
  const existing = { ...shell, worktreeId: "31" }
  receive({ kind: "terminalChanged", terminal: existing })
  listed.resolve([])

  await refreshing
  await expect(opening).resolves.toEqual(existing)
  expect(store.sessions).toEqual([existing])
  expect(list).toHaveBeenCalledOnce()
  expect(dial).not.toHaveBeenCalled()
})

test("a stale list preserves the latest terminal update and does not restore a hung-up shell", async () => {
  const listed = deferred<TerminalSummary[]>()
  vi.spyOn(platformClient.terminal, "list").mockReturnValue(listed.promise)
  const store = setup()
  const refreshing = store.refresh()
  receive({ kind: "terminalChanged", terminal: { ...shell, status: "interrupted" } })
  const updated = { ...shell, title: "updated shell" }
  receive({ kind: "terminalChanged", terminal: updated })
  receive({ kind: "terminalChanged", terminal: { ...shell, id: "closed-shell" } })
  receive({ kind: "terminalHungup", terminalId: "closed-shell" })
  const unrelated = { ...shell, id: "other-shell" }
  listed.resolve([shell, { ...shell, id: "closed-shell" }, unrelated])

  await refreshing
  expect(store.sessions).toEqual([updated, unrelated])
})

test("local creation and hangup survive a list response even before their catalog events arrive", async () => {
  const listed = deferred<TerminalSummary[]>()
  vi.spyOn(platformClient.terminal, "list").mockReturnValue(listed.promise)
  vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({ ...shell, id: options.terminalId }))
  vi.spyOn(platformClient.terminal, "hangup").mockResolvedValue()
  const store = setup()
  const refreshing = store.refresh()
  const created = await store.create()
  await store.hangup(shell.id)
  listed.resolve([shell])

  await refreshing
  expect(store.sessions).toEqual([created])
})

test("reattaching dials the existing shell before using the data channel; detach does not hang up", async () => {
  const dial = vi.spyOn(platformClient.terminal, "dial").mockResolvedValue(shell)
  const hangup = vi.spyOn(platformClient.terminal, "hangup")
  const detach = vi.fn()
  vi.spyOn(TerminalClient.prototype, "subscribe").mockReturnValue(detach)
  const call = vi.spyOn(TerminalClient.prototype, "call").mockResolvedValue(shell)
  const store = setup()
  const attached = store.attach(shell.id, () => {})
  await attached.ready
  expect(dial).toHaveBeenCalledWith({ mode: "resume", terminalId: shell.id })
  expect(dial.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]!)
  expect(call).toHaveBeenCalledWith("attach", { sessionId: shell.id })
  attached.detach()
  expect(detach).toHaveBeenCalledOnce()
  expect(hangup).not.toHaveBeenCalled()
})

test("a fast command's exit survives a stale attachment response", async () => {
  vi.spyOn(platformClient.terminal, "dial").mockResolvedValue(shell)
  vi.spyOn(TerminalClient.prototype, "subscribe").mockReturnValue(() => {})
  const attaching = deferred<TerminalSummary>()
  vi.spyOn(TerminalClient.prototype, "call").mockReturnValue(attaching.promise)
  const store = setup()
  const attached = store.attach(shell.id, () => {})
  await vi.waitFor(() => expect(store.sessions).toEqual([shell]))
  receive({ kind: "terminalChanged", terminal: { ...shell, status: "exited", exitCode: 0 } })
  attaching.resolve(shell)
  await expect(attached.ready).resolves.toMatchObject({ status: "exited", exitCode: 0 })
  expect(store.sessions).toEqual([{ ...shell, status: "exited", exitCode: 0 }])
})
