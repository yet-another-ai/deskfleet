import { installCentralAccount } from "./central-account.ts"
import { app, powerMonitor, powerSaveBlocker } from "electron"
import { join } from "node:path"
import { daemonControlDirectory } from "@deskfleet/daemon/control-discovery"
import { resolveAppLocale } from "../../../../packages/client/src/i18n.ts"
import { installDesktopMediaIpc } from "./desktop-media.ts"
import { setMainLocale } from "./i18n.ts"
import { keepRunningInBackground } from "./lifecycle.ts"
import { KeepAwakeController } from "./keep-awake.ts"
import { LocalAgentController } from "./local-agent-controller.ts"
import { createLocalAgentRuntime } from "./local-agent-runtime.ts"
import { NotificationSettingsController } from "./notification-settings.ts"
import { DesktopNotifications } from "./notifications.ts"
import { TaskNotificationMonitor } from "./task-notification-monitor.ts"
import { installSettings, publishLocalAgentState } from "./settings.ts"
import { WorktreeRootSettingsController } from "./worktree-root-settings.ts"
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
    const central = await installCentralAccount()
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
    const keepAwake = new KeepAwakeController(join(app.getPath("userData"), "keep-awake.json"), powerSaveBlocker)
    const notificationSettings = new NotificationSettingsController(join(app.getPath("userData"), "notifications.json"))
    const notifications = new DesktopNotifications(notificationSettings, show)
    const notificationMonitor = new TaskNotificationMonitor(central, notification => notifications.notify(notification), console.error)
    installSettings(localAgent, keepAwake, notificationSettings, new WorktreeRootSettingsController(daemonControlDirectory()))
    if (process.platform === "win32") app.setAppUserModelId("io.github.yet-another-ai.deskfleet")
    void notificationMonitor.start().catch(console.error)
    // The hosted daemon outlives windows but not the app. Exit once it has
    // released its sessions, terminals, and discovery.
    let closing: Promise<void> | undefined
    app.on("will-quit", (event) => {
      event.preventDefault()
      notificationMonitor.close()
      notifications.close()
      closing ??= localAgent.close().finally(() => keepAwake.close()).then(
        () => app.exit(0),
        (error: unknown) => { console.error(error); app.exit(1) },
      )
    })
    try { keepAwake.get() } catch (error) { console.error(error) }
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
