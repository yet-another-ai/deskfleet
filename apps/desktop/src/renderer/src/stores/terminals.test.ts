import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { TerminalSessionEvent, TerminalSummary } from "../../../shared/terminal.ts"
import { TerminalClient } from "../services/terminal-client.ts"
import { useTerminalsStore } from "./terminals.ts"

const shell: TerminalSummary = { id: "shell-1", title: "home", cwd: "/home/user", cols: 80, rows: 24, status: "running" }
const stores: ReturnType<typeof useTerminalsStore>[] = []
let receive: (event: TerminalSessionEvent) => void

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(window.deskfleet.terminal, "onSessionEvent").mockImplementation((listener) => {
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
  const list = vi.spyOn(window.deskfleet.terminal, "list").mockResolvedValue([shell])
  const dial = vi.spyOn(window.deskfleet.terminal, "dial").mockImplementation(async (options) => ({ ...shell, id: options.terminalId }))
  const hangup = vi.spyOn(window.deskfleet.terminal, "hangup").mockResolvedValue()
  const offer = vi.spyOn(window.deskfleet.terminal, "offer")
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

test("reattaching dials the existing shell before using the data channel; detach does not hang up", async () => {
  const dial = vi.spyOn(window.deskfleet.terminal, "dial").mockResolvedValue(shell)
  const hangup = vi.spyOn(window.deskfleet.terminal, "hangup")
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
