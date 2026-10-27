import type { AgentQuotaAuthority } from "./agent-quotas.ts"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { checkAccessibilityAccess, checkFullDiskAccess, checkScreenCaptureAccess, checkWaylandDesktopAccess, closeWaylandDesktopAccess, nativeInfo, requestAccessibilityAccess, requestFullDiskAccess, requestScreenCaptureAccess, requestWaylandDesktopAccess, waitWaylandDesktopAccessChange } from "@deskfleet/native"
import { PeerSessions } from "./peers.ts"
import { startControlServer } from "./control-server.ts"
import { daemonControlDirectory } from "./control-discovery.ts"
import { DesktopPermissions } from "./desktop-permissions.ts"
import { WaylandDesktopPermissions, type WaylandDesktopPermissionApi } from "./wayland-desktop-permissions.ts"
import type { AgentProvider } from "./agents/acp.ts"
import type { DaemonCatalog } from "./catalog.ts"

export async function startDaemon(port = 0, options: {
  controlDirectory?: string
  requestScreenCaptureAccess?: () => Promise<boolean | null>
  requestAccessibilityAccess?: () => Promise<boolean | null>
  requestFullDiskAccess?: () => Promise<boolean | null>
  checkScreenCaptureAccess?: () => Promise<boolean | null>
  checkAccessibilityAccess?: () => Promise<boolean | null>
  checkFullDiskAccess?: () => Promise<boolean | null>
  /** macOS welcome setup guides requests over IPC; Wayland always authorizes at startup. */
  permissionMode?: "automatic" | "guided"
  /** In-process permission fixtures; production uses the current platform. */
  permissionPlatform?: NodeJS.Platform
  waylandDesktopAccess?: WaylandDesktopPermissionApi
  agentProvider?: AgentProvider
  agentQuotas?: AgentQuotaAuthority
  openCatalog?: Parameters<DaemonCatalog["init"]>[0]
  /** In-process fixtures only. Never enabled by configuration, IPC, or the CLI. */
  allowLocalControlForTests?: boolean
} = {}) {
  const native = nativeInfo()
  const permissions = new DesktopPermissions()
  const peers = new PeerSessions()
  const controlDirectory = options.controlDirectory ?? daemonControlDirectory()
  const wayland = (options.permissionPlatform ?? process.platform) === "linux"
    ? new WaylandDesktopPermissions(controlDirectory, options.waylandDesktopAccess ?? {
      request: requestWaylandDesktopAccess, check: checkWaylandDesktopAccess, close: closeWaylandDesktopAccess,
      subscribe: watchWaylandDesktopAccess,
    }) : undefined
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
          () => wayland?.close(),
          () => control?.stop(),
          () => peers.closeAll(),
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
    control = await startControlServer(peers, controlDirectory, undefined, undefined, () => { void close() }, permissions, options.agentProvider, {
      allowLocalControlForTests: options.allowLocalControlForTests, openCatalog: options.openCatalog, agentQuotas: options.agentQuotas,
    })
  } catch (error) {
    const cleanup = await Promise.allSettled([peers.closeAll(), server[Symbol.asyncDispose]()])
    const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError([error, ...failures], "Daemon startup and cleanup failed", { cause: error })
    throw error
  }
  // Request OS access when creating the owning daemon, before clients use its files or desktop.
  permissions.onChange(() => control?.central.desktopCapabilitiesChanged())
  const stopReportingFileAccess = permissions.onChange(({ fullDiskAccessPermission }) => {
    if (fullDiskAccessPermission.status === "checking" || fullDiskAccessPermission.status === "requesting") return
    stopReportingFileAccess()
    if (fullDiskAccessPermission.status === "denied" || fullDiskAccessPermission.status === "error") {
      console.error("Local Agent file access: enable Full Disk Access for the app or executable hosting the daemon in macOS System Settings > Privacy & Security, then restart it.",
        fullDiskAccessPermission.error ?? "")
    }
  })
  permissions.initialize(wayland?.requests ?? {
    screenCapture: options.requestScreenCaptureAccess ?? requestScreenCaptureAccess,
    accessibility: options.requestAccessibilityAccess ?? requestAccessibilityAccess,
    fullDiskAccess: options.requestFullDiskAccess ?? requestFullDiskAccess,
  }, wayland?.checks ?? {
    screenCapture: options.checkScreenCaptureAccess ?? checkScreenCaptureAccess,
    accessibility: options.checkAccessibilityAccess ?? checkAccessibilityAccess,
    fullDiskAccess: options.checkFullDiskAccess ?? checkFullDiskAccess,
  }, wayland ? "automatic" : options.permissionMode, wayland ? {
    linked: [["screenCapture", "accessibility"]], refreshOnRead: true,
  } : {})
  wayland?.onAccessChanged(() => { void permissions.refreshAfterChange() })
  return {
    address: `http://127.0.0.1:${address.port}`,
    peers,
    get terminals() { return control!.terminals },
    get central() { return control!.central },
    /** Completes after discovery and all native/server resources have closed. */
    closed,
    close,
  }
}

function watchWaylandDesktopAccess(listener: () => void): () => void {
  let stopped = false
  let seen = 0
  const run = async () => {
    while (!stopped) {
      const generation = await waitWaylandDesktopAccessChange(seen)
      if (stopped || generation === null) return
      seen = generation
      listener()
    }
  }
  void run().catch(error => {
    if (stopped) return
    console.error("Wayland desktop permission watch failed:", error instanceof Error ? error.message : error)
  })
  return () => { stopped = true }
}
