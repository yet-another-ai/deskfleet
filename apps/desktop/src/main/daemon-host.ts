import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { app, powerMonitor } from "electron"
import { createCodexProvider, startDaemon } from "@deskfleet/daemon"
import { daemonControlDirectory } from "@deskfleet/daemon/control-discovery"
import { CODEX_ACP_HOST_ARGUMENT } from "../shared/daemon-launch.ts"

/** Run the daemon library without installing the desktop client's UI lifecycle. */
export function startDaemonHost(): void {
  const directory = join(daemonControlDirectory(), "electron-profile")
  mkdirSync(directory, { recursive: true })
  app.setPath("userData", directory)
  app.setPath("sessionData", directory)
  if (process.platform === "darwin") app.setActivationPolicy("prohibited")

  const fail = (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
  const daemon = app.whenReady().then(() => {
    // Electron installs its signal handlers during startup. Register ours after
    // ready so shutdown waits for the library to release sessions and storage.
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
    powerMonitor.on("shutdown", shutdown)
    return startDaemon(0, {
      agentProvider: createCodexProvider({
        command: process.execPath,
        args: [...(app.isPackaged ? [] : [app.getAppPath()]), CODEX_ACP_HOST_ARGUMENT],
        env: { ELECTRON_RUN_AS_NODE: undefined },
      }),
    })
  })
  function shutdown(): void {
    void daemon.then((running) => running.close()).catch(fail)
  }

  app.on("window-all-closed", () => {})
  app.on("before-quit", (event) => {
    event.preventDefault()
    shutdown()
  })
  void daemon.then(async (running) => {
    await running.closed
    app.exit(0)
  }).catch(fail)
}
