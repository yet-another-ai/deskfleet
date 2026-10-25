import { stat } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { startDaemon } from "@deskfleet/daemon"
import { DaemonClient } from "@deskfleet/daemon/control-client"
import { daemonDiscoveryPath } from "@deskfleet/daemon/control-discovery"
import type { LocalAgentRuntime } from "./local-agent-controller.ts"
import type { DesktopPermissionsState } from "../../../../packages/client/src/local-agent.ts"

export interface HostedDaemon {
  /** Settles after discovery and all native/server resources have closed. */
  readonly closed: Promise<void>
  close(): Promise<void>
}

export interface LocalAgentRuntimeOptions {
  directory: string
  /** Starts the daemon library in this process; tests inject a deterministic host. */
  start?: (directory: string) => Promise<HostedDaemon>
}

/** Hosts the daemon library in the app process: it outlives windows, not the app. */
export function createLocalAgentRuntime(options: LocalAgentRuntimeOptions): LocalAgentRuntime {
  const start = options.start ?? (directory => startDaemon(0, { controlDirectory: directory, permissionMode: "guided" }))
  let hosted: HostedDaemon | undefined
  return {
    async connect(onDisconnect, onPermissionsChanged) {
      let permissions: DesktopPermissionsState | undefined
      let permissionsRevision = 0
      const client = await DaemonClient.connect(event => {
        if (event.kind !== "desktopPermissionsChanged") return
        permissions = event.permissions
        permissionsRevision += 1
        onPermissionsChanged(permissions)
      }, onDisconnect, options.directory)
      return {
        get closed() { return client.closed },
        // Events can arrive alongside hello, before connect() resolves.
        get desktopPermissions() {
          return permissions ?? {
            fullDiskAccessPermission: client.info!.fullDiskAccessPermission,
            screenCapturePermission: client.info!.screenCapturePermission,
            accessibilityPermission: client.info!.accessibilityPermission,
          }
        },
        refreshPermissions: async () => {
          const revision = permissionsRevision
          const result = await client.call("permissionsRefresh", {})
          if (revision === permissionsRevision) permissions = result
          return permissions!
        },
        requestPermission: async permission => {
          const revision = permissionsRevision
          const result = await client.call("permissionRequest", { permission })
          if (revision === permissionsRevision) permissions = result
          return permissions!
        },
        shutdown: async () => { await client.call("shutdown", {}) },
        close: () => client.close(),
      }
    },
    async start() {
      const daemon = await start(options.directory)
      hosted = daemon
      // A remote shutdown request also closes the hosted daemon.
      void daemon.closed.catch(() => {}).finally(() => { if (hosted === daemon) hosted = undefined })
    },
    async waitForShutdown() {
      if (hosted) { await hosted.closed; return }
      // A separately running daemon, such as the headless executable, removes its discovery on exit.
      const deadline = Date.now() + 15_000
      for (;;) {
        try { await stat(daemonDiscoveryPath(options.directory)) }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return
          throw error
        }
        if (Date.now() >= deadline) throw new Error("Local Agent is still shutting down")
        await delay(100)
      }
    },
    async close() {
      await hosted?.close()
    },
  }
}
