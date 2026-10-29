import { createServer, type Socket } from "node:net"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, expect, test, vi } from "vitest"
import { app } from "electron"
import { daemonControlDirectory } from "../../../daemon/src/control-discovery.ts"
import { DaemonClient } from "./daemon-client.ts"

vi.mock("electron", () => ({ app: { getPath: vi.fn() } }))

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.unstubAllEnvs()
})

async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), "df-client-"))
  cleanups.push(() => rm(profile, { recursive: true, force: true }))
  vi.mocked(app.getPath).mockReturnValue(profile)
  const directory = join(profile, "daemon")
  await mkdir(directory)
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\df-${randomUUID()}` : join(profile, "control.sock")
  const token = "a".repeat(64)
  await writeFile(join(directory, "daemon.json"), JSON.stringify({ endpoint, token }))
  const sockets = new Set<Socket>()
  const requests: Array<{ id: number; method: string; params: unknown }> = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    socket.setEncoding("utf8")
    let buffer = ""
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline)) as (typeof requests)[number]
        buffer = buffer.slice(newline + 1)
        requests.push(request)
        const result = request.method === "hello" ? { name: "local fixture", desktop: true } : null
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
      }
    })
  })
  server.listen(endpoint)
  await once(server, "listening")
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { profile, directory, token, requests, sockets }
}

test("local IPC authenticates before operations and delivers fragmented trickle ICE", async () => {
  const server = await fixture()
  const event = vi.fn()
  const client = await DaemonClient.connect(event, vi.fn())
  cleanups.push(() => client.close())
  expect(server.requests[0]).toMatchObject({ method: "hello", params: { token: server.token } })
  expect(client.info).toEqual({ name: "local fixture", desktop: true })
  const payload = JSON.stringify({ event: { kind: "iceCandidate", sessionId: "session", candidate: { candidate: "candidate:fixture" } } })
  const socket = [...server.sockets][0]!
  socket.write(payload.slice(0, 29))
  socket.write(`${payload.slice(29)}\n`)
  await vi.waitFor(() => expect(event).toHaveBeenCalledWith(JSON.parse(payload).event))
  await client.call("close", { sessionId: "session" })
  expect(server.requests[1]?.method).toBe("close")
})

test("losing the daemon rejects outstanding operations and reports disconnection once", async () => {
  const server = await fixture()
  const disconnected = vi.fn()
  const client = await DaemonClient.connect(vi.fn(), disconnected)
  cleanups.push(() => client.close())
  const socket = [...server.sockets][0]!
  socket.removeAllListeners("data")
  const received = once(socket, "data")
  const pending = client.call("capabilities", {})
  const rejected = expect(pending).rejects.toThrow("disconnected")
  // Drain the request before closing so the fixture produces EOF, not a reset.
  await received
  socket.destroy()
  await rejected
  expect(disconnected).toHaveBeenCalledTimes(1)
  expect(client.closed).toBe(true)
})

test("desktop discovery follows the current profile without changing headless discovery", async () => {
  const headless = await fixture()
  const desktop = await fixture()
  vi.stubEnv("DESKFLEET_DAEMON_DIRECTORY", headless.directory)
  const client = await DaemonClient.connect(vi.fn(), vi.fn())
  cleanups.push(() => client.close())
  expect(headless.requests).toHaveLength(0)
  expect(desktop.requests[0]?.method).toBe("hello")
  expect(app.getPath).toHaveBeenCalledWith("userData")
  expect(daemonControlDirectory()).toBe(headless.directory)

  vi.mocked(app.getPath).mockReturnValue(headless.profile)
  const other = await DaemonClient.connect(vi.fn(), vi.fn())
  cleanups.push(() => other.close())
  expect(headless.requests[0]?.method).toBe("hello")
})

test("a profile without a daemon never falls back to a running headless daemon", async () => {
  const headless = await fixture()
  vi.stubEnv("DESKFLEET_DAEMON_DIRECTORY", headless.directory)
  vi.mocked(app.getPath).mockReturnValue(join(headless.profile, "empty-profile"))
  await expect(DaemonClient.connect(vi.fn(), vi.fn())).rejects.toMatchObject({ code: "ENOENT" })
  expect(headless.requests).toHaveLength(0)
})
