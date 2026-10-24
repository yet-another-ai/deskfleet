import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { nativeInfo, requestScreenCaptureAccess } from "@deskfleet/native"
import { PeerSessions } from "./peers.ts"
import { startControlServer } from "./control-server.ts"
import { TerminalSessions } from "./terminals.ts"
import { daemonControlDirectory } from "./control-discovery.ts"
import { ScreenCapturePermissions } from "./screen-capture-permission.ts"
import type { AgentProvider } from "./agents/acp.ts"

export async function startDaemon(port = 0, options: {
  controlDirectory?: string
  requestScreenCaptureAccess?: () => Promise<boolean | null>
  agentProvider?: AgentProvider
} = {}) {
  const native = nativeInfo()
  const permissions = new ScreenCapturePermissions()
  const peers = new PeerSessions()
  const controlDirectory = options.controlDirectory ?? daemonControlDirectory()
  const terminals = new TerminalSessions({ directory: join(controlDirectory, "terminals") })
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ status: "ok", native }))
      return
    }
    response.writeHead(404)
    response.end()
  })

  server.listen(port, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as AddressInfo

  let control: Awaited<ReturnType<typeof startControlServer>> | undefined
  let resolveClosed!: () => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  // Callers can await either close() or closed without an unhandled rejection.
  void closed.catch(() => {})
  let closing = false
  const close = (): Promise<void> => {
    if (!closing) {
      closing = true
      void (async () => {
        const failures: unknown[] = []
        for (const cleanup of [
          () => control?.stop(),
          () => peers.closeAll(),
          () => terminals.close(),
          () => server[Symbol.asyncDispose](),
          () => control?.close(),
        ]) {
          try { await cleanup() } catch (error) { failures.push(error) }
        }
        if (failures.length) throw new AggregateError(failures, "Daemon shutdown failed")
      })().then(resolveClosed, rejectClosed)
    }
    return closed
  }
  try {
    control = await startControlServer(peers, controlDirectory, undefined, terminals, () => { void close() }, permissions, options.agentProvider)
  } catch (error) {
    const cleanup = await Promise.allSettled([peers.closeAll(), terminals.close(), server[Symbol.asyncDispose]()])
    const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError([error, ...failures], "Daemon startup and cleanup failed", { cause: error })
    throw error
  }
  // Request once we own the machine daemon, before any remote capture is used.
  permissions.request(options.requestScreenCaptureAccess ?? requestScreenCaptureAccess)
  return {
    address: `http://127.0.0.1:${address.port}`,
    peers,
    terminals,
    /** Completes after discovery and all native/server resources have closed. */
    closed,
    close,
  }
}
