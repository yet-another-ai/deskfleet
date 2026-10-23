import { app, powerMonitor } from "electron"
import { join } from "node:path"
import { daemonControlDirectory } from "@deskfleet/daemon/control-discovery"
import { resolveAppLocale } from "../shared/i18n.ts"
import { installDesktopMediaIpc } from "./desktop-media.ts"
import { setMainLocale } from "./i18n.ts"
import { keepRunningInBackground } from "./lifecycle.ts"
import { LocalAgentController } from "./local-agent-controller.ts"
import { createLocalAgentRuntime } from "./local-agent-runtime.ts"
import { installSettings, publishLocalAgentState } from "./settings.ts"
import {
  denyChromiumPermissions,
  installRendererProtocol,
  registerRendererScheme,
} from "./renderer-protocol.ts"
import { createTray } from "./tray.ts"
import { hideMainWindow, showMainWindow } from "./windows.ts"

function start(): void {
  registerRendererScheme()
  const lifecycle = keepRunningInBackground(app, hideMainWindow)
  const show = () => void showMainWindow(lifecycle)

  app.on("second-instance", show)

  void app.whenReady().then(async () => {
    setMainLocale(resolveAppLocale(app.getPreferredSystemLanguages()))
    installRendererProtocol()
    installDesktopMediaIpc()
    denyChromiumPermissions()
    // The dev runner, service managers, and session shutdown stop the client with
    // signals. Electron's own handlers, installed during startup, request an
    // ordinary quit that the tray lifecycle blocks; registering after ready
    // replaces them.
    process.once("SIGINT", () => lifecycle.quit())
    process.once("SIGTERM", () => lifecycle.quit())
    // Logging out or shutting down must not wait on a client hidden in the tray.
    powerMonitor.on("shutdown", () => lifecycle.quit())
    const localAgent = new LocalAgentController(
      join(app.getPath("userData"), "settings.json"),
      createLocalAgentRuntime({ directory: daemonControlDirectory() }),
      publishLocalAgentState,
    )
    installSettings(localAgent)
    // The hosted daemon outlives windows but not the app. Exit once it has
    // released its sessions, terminals, and discovery.
    let closing: Promise<void> | undefined
    app.on("will-quit", (event) => {
      event.preventDefault()
      closing ??= localAgent.close().then(
        () => app.exit(0),
        (error: unknown) => { console.error(error); app.exit(1) },
      )
    })
    await localAgent.initialize()
    if (lifecycle.quitting) return
    createTray({ show, quit: () => lifecycle.quit() })
    show()
    app.on("activate", show)
  })
}

// A second launch focuses the running client instead of adding another tray icon.
if (app.requestSingleInstanceLock()) {
  start()
} else {
  app.quit()
}
