import { expect, test, vi } from "vitest"
import type { CentralEvent } from "@deskfleet/client/central"
import type { PortForwardRequest } from "@deskfleet/client/ports"
import type { PortConnection } from "@deskfleet/client/ports-signaling"
import { PortForwards, type OpenPortForward } from "./ports-controller.ts"

const request: PortForwardRequest = { target: { teamId: "team", machineId: "machine" }, targetPort: 3000 }
const connection = (localPort = 41000) => ({ localPort, close: vi.fn(async () => {}) })
function fixture(open: OpenPortForward) {
  let event!: (event: CentralEvent) => void
  const unsubscribe = vi.fn()
  const central = { onEvent: (listener: (event: CentralEvent) => void) => { event = listener; return unsubscribe } }
  const manager = new PortForwards(central, open)
  return { manager, unsubscribe, accountChanged: () => event({ type: "accountChanged" }) }
}

test("forwards are app-owned, independently stoppable, and cleared on account changes", async () => {
  const first = connection(), second = connection(41001), third = connection(41002)
  const open = vi.fn<OpenPortForward>().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third)
  const f = fixture(open)
  const one = await f.manager.start(request), two = await f.manager.start({ ...request, targetHost: "::1", localPort: 41001 })
  expect(one).toMatchObject({ localHost: "127.0.0.1", localPort: 41000, targetHost: "127.0.0.1", targetPort: 3000 })
  expect(two).toMatchObject({ localPort: 41001, targetHost: "::1" })
  // Returned metadata cannot retarget a running listener.
  one.target.machineId = "changed"
  expect((await f.manager.list())[0]?.target.machineId).toBe("machine")
  await f.manager.stop(one.id)
  await f.manager.stop(one.id)
  expect(first.close).toHaveBeenCalledOnce()
  expect(second.close).not.toHaveBeenCalled()
  expect(await f.manager.list()).toEqual([two])
  f.accountChanged()
  expect(await f.manager.list()).toEqual([])
  await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce())
  await f.manager.start(request)
  await f.manager.close()
  expect(third.close).toHaveBeenCalledOnce()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
  await expect(f.manager.start(request)).rejects.toThrow("closed")
})

test.each(["account", "quit"])("%s aborts pending negotiation and closes a late native result", async cause => {
  let complete!: (value: PortConnection) => void
  let signal!: AbortSignal
  const f = fixture((_request, _failed, value) => { signal = value; return new Promise(resolve => { complete = resolve }) })
  const pending = f.manager.start(request)
  const rejected = expect(pending).rejects.toThrow("cancelled")
  await Promise.resolve()
  const closing = cause === "quit" ? f.manager.close() : (f.accountChanged(), Promise.resolve())
  expect(signal.aborted).toBe(true)
  expect(await f.manager.list()).toEqual([])
  const late = connection()
  complete(late)
  await rejected
  await closing
  await f.manager.close()
  expect(late.close).toHaveBeenCalledOnce()
})

test("peer failures remove the listener and close its connection", async () => {
  let fail!: (error: Error) => void
  const native = connection()
  const f = fixture(async (_request, failed) => { fail = failed; return native })
  await f.manager.start(request)
  fail(new Error("grant revoked"))
  expect(await f.manager.list()).toEqual([])
  await f.manager.close()
  expect(native.close).toHaveBeenCalledOnce()
})

test("synchronous failure on abort joins the existing retirement", async () => {
  const native = connection()
  const f = fixture(async (_request, failed, signal) => {
    signal.addEventListener("abort", () => failed(new Error("connection cancelled")), { once: true })
    return native
  })
  const forward = await f.manager.start(request)
  await f.manager.stop(forward.id)
  await f.manager.close()
  expect(native.close).toHaveBeenCalledOnce()
  expect(await f.manager.list()).toEqual([])
})

test("a failure during connector startup cannot publish a forwarding entry", async () => {
  const native = connection()
  const f = fixture(async (_request, failed) => { failed(new Error("peer closed")); return native })
  await expect(f.manager.start(request)).rejects.toThrow("cancelled")
  expect(await f.manager.list()).toEqual([])
  await f.manager.close()
  expect(native.close).toHaveBeenCalledOnce()
})

test("setup errors are returned without leaving a listener entry", async () => {
  const f = fixture(async () => { throw new Error("Address already in use") })
  await expect(f.manager.start(request)).rejects.toThrow("Address already in use")
  expect(await f.manager.list()).toEqual([])
  await f.manager.close()
})
