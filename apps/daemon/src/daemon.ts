import type { AgentQuotaAuthority } from "./agent-quotas.ts"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { checkAccessibilityAccess, checkFullDiskAccess, checkScreenCaptureAccess, checkLinuxDesktopAccess, closeLinuxDesktopAccess, linuxDesktopBackend, nativeInfo, requestAccessibilityAccess, requestFullDiskAccess, requestScreenCaptureAccess, requestLinuxDesktopAccess, waitLinuxDesktopAccessChange } from "@deskfleet/native"
import { PeerSessions } from "./peers.ts"
import { startControlServer } from "./control-server.ts"
import { daemonControlDirectory } from "./control-discovery.ts"
import { DesktopPermissions } from "./desktop-permissions.ts"
import { LinuxDesktopPermissions, type LinuxDesktopPermissionApi } from "./linux-desktop-permissions.ts"
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
  linuxDesktopAccess?: LinuxDesktopPermissionApi
  linuxDesktopBackend?: "wayland" | "x11" | null
  agentProvider?: AgentProvider
  agentQuotas?: AgentQuotaAuthority
  openCatalog?: Parameters<DaemonCatalog["init"]>[0]
  /** In-process fixtures only. Never enabled by configuration, IPC, or the CLI. */
  allowLocalControlForTests?: boolean
} = {}) {
  const native = nativeInfo()
  const isLinux = (options.permissionPlatform ?? process.platform) === "linux"
  const backend = isLinux ? options.linuxDesktopBackend !== undefined ? options.linuxDesktopBackend : linuxDesktopBackend() : undefined
  const permissions = new DesktopPermissions(backend)
  const peers = new PeerSessions()
  const controlDirectory = options.controlDirectory ?? daemonControlDirectory()
  const linux = isLinux
    ? new LinuxDesktopPermissions(controlDirectory, options.linuxDesktopAccess ?? {
      request: requestLinuxDesktopAccess, check: checkLinuxDesktopAccess, close: closeLinuxDesktopAccess,
      subscribe: watchLinuxDesktopAccess,
    }, backend) : undefined
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
          () => linux?.close(),
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
  permissions.initialize(linux?.requests ?? {
    screenCapture: options.requestScreenCaptureAccess ?? requestScreenCaptureAccess,
    accessibility: options.requestAccessibilityAccess ?? requestAccessibilityAccess,
    fullDiskAccess: options.requestFullDiskAccess ?? requestFullDiskAccess,
  }, linux?.checks ?? {
    screenCapture: options.checkScreenCaptureAccess ?? checkScreenCaptureAccess,
    accessibility: options.checkAccessibilityAccess ?? checkAccessibilityAccess,
    fullDiskAccess: options.checkFullDiskAccess ?? checkFullDiskAccess,
  }, isLinux ? backend === "wayland" ? "automatic" : "guided" : options.permissionMode, linux ? {
    linked: backend === "wayland" ? [["screenCapture", "accessibility"]] : [], refreshOnRead: true,
  } : {})
  linux?.onAccessChanged(() => { void permissions.refreshAfterChange() })
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

function watchLinuxDesktopAccess(listener: () => void): () => void {
  let stopped = false
  let seen = 0
  const run = async () => {
    while (!stopped) {
      const generation = await waitLinuxDesktopAccessChange(seen)
      if (stopped || generation === null) return
      seen = generation
      listener()
    }
  }
  void run().catch(error => {
    if (stopped) return
    console.error("Linux desktop permission watch failed:", error instanceof Error ? error.message : error)
  })
  return () => { stopped = true }
}
