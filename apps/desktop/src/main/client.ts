import { installCentralAccount } from "./central-account.ts"
import { installFiles } from "./files.ts"
import { installPorts } from "./ports.ts"
import { installLocalChannels } from "./local-channels.ts"
import { installLocalApplications } from "./applications.ts"
import { app, powerMonitor, powerSaveBlocker } from "electron"
import { join } from "node:path"
import { daemonControlDirectory } from "@deskfleet/daemon/control-discovery"
import { AppearanceSettingsController } from "./appearance-settings.ts"
import { installAppearance } from "./appearance.ts"
import { installDesktopMediaIpc } from "./desktop-media.ts"
import { keepRunningInBackground } from "./lifecycle.ts"
import { KeepAwakeController } from "./keep-awake.ts"
import { LocalAgentController } from "./local-agent-controller.ts"
import { createLocalAgentRuntime } from "./local-agent-runtime.ts"
import { establishedDesktopProfile, OnboardingController } from "./onboarding-controller.ts"
import { installOnboarding } from "./onboarding.ts"
import { NotificationSettingsController } from "./notification-settings.ts"
import { DesktopNotifications } from "./notifications.ts"
import { TaskNotificationMonitor } from "@deskfleet/client/task-notification-monitor"
import { installSettings, publishLocalAgentState } from "./settings.ts"
import { WorktreeRootSettingsController } from "./worktree-root-settings.ts"
import { configureApplicationDisplay } from "./application-display.ts"
import {
  installRendererPermissions,
  installRendererProtocol,
  registerRendererScheme,
} from "./renderer-protocol.ts"
import { createTray } from "./tray.ts"
import { installUpdates } from "./updates.ts"
import { hideMainWindow, showMainWindow } from "./windows.ts"

function start(): void {
  registerRendererScheme()
  const lifecycle = keepRunningInBackground(app, hideMainWindow)
  const show = () => void showMainWindow(lifecycle)

  app.on("second-instance", show)

  void app.whenReady().then(async () => {
    configureApplicationDisplay()
    installAppearance(new AppearanceSettingsController(join(app.getPath("userData"), "appearance.json")))
    installRendererProtocol()
    installDesktopMediaIpc()
    const central = await installCentralAccount()
    installLocalApplications(central)
    const files = installFiles(central)
    const ports = installPorts(central)
    const localChannels = installLocalChannels(central)
    installRendererPermissions()
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
    const userData = app.getPath("userData")
    const onboarding = new OnboardingController({
      path: join(userData, "onboarding.json"), platform: process.platform, localAgent,
      established: () => establishedDesktopProfile(userData),
    })
    installOnboarding(onboarding)
    const notificationSettings = new NotificationSettingsController(join(app.getPath("userData"), "notifications.json"))
    const notifications = new DesktopNotifications(notificationSettings, show)
    const notificationMonitor = new TaskNotificationMonitor(central, notification => notifications.notify(notification), console.error)
    installSettings(localAgent, keepAwake, notificationSettings, new WorktreeRootSettingsController(daemonControlDirectory()))
    if (process.platform === "win32") app.setAppUserModelId("io.github.yet-another-ai.deskfleet")
    void notificationMonitor.start().catch(console.error)
    // The hosted daemon outlives windows but not the app. Exit once it has
    // released its sessions, terminals, and discovery.
    let closing: Promise<void> | undefined
    let servicesClosed = false
    const closeServices = (): Promise<void> => {
      notificationMonitor.close()
      notifications.close()
      closing ??= Promise.allSettled([localAgent.close(), files.close(), ports.close(), localChannels.close()]).then(results => {
        const failure = results.find(result => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
        servicesClosed = true
      }).finally(() => keepAwake.close()).catch((error: unknown) => { closing = undefined; throw error })
      return closing
    }
    const updates = await installUpdates(lifecycle, closeServices)
    app.on("will-quit", (event) => {
      updates.close()
      // Let the updater's own quit/relaunch finish once the same shutdown barrier
      // has already completed. Ordinary exits still wait for hosted services.
      if (servicesClosed) return
      event.preventDefault()
      void closeServices().then(
        () => app.exit(0),
        (error: unknown) => { console.error(error); app.exit(1) },
      )
    })
    try { keepAwake.get() } catch (error) { console.error(error) }
    await localAgent.initialize()
    try { await onboarding.get() } catch (error) { console.error(error) }
    if (lifecycle.quitting) return
    updates.start()
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
