import { installCentralAccount } from "./central-account.ts"
import { installFiles } from "./files.ts"
import { installPorts } from "./ports.ts"
import { installLocalChannels } from "./local-channels.ts"
import { installMuxChannels } from "./mux-channels.ts"
import { installLocalApplications } from "./applications.ts"
import { installNetworkDiagnostics } from "./network-diagnostics.ts"
import { installSpeech } from "./speech.ts"
import { bundledDshRuntime, configureDshRuntime, electronDshHost, sourceDshRuntime } from "@deskfleet/dsh-runtime"
import { app, powerMonitor, powerSaveBlocker } from "electron"
import { openLocalNetworkSettings, requestLocalNetworkAccess } from "@deskfleet/native"
import { join } from "node:path"
import { prepareAuv } from "./auv.ts"
import { AuvPermissionsController } from "./auv-permissions-controller.ts"
import { desktopDaemonDirectory, desktopWorkspaceDirectory } from "./daemon-directory.ts"
import { AppearanceSettingsController } from "./appearance-settings.ts"
import { installAppearance } from "./appearance.ts"
import { installDesktopMediaIpc } from "./desktop-media.ts"
import { installNativeDesktop } from "./native-desktop.ts"
import { keepRunningInBackground } from "./lifecycle.ts"
import { startAppImageRestart } from "./appimage-restart.ts"
import { KeepAwakeController } from "./keep-awake.ts"
import { refreshLaunchAtStartup } from "./launch-at-startup.ts"
import { configureLinuxPasswordStore, LinuxKeyringSettingsController } from "./linux-keyring-settings.ts"
import { LocalAgentController } from "./local-agent-controller.ts"
import { createLocalAgentRuntime } from "./local-agent-runtime.ts"
import { establishedDesktopProfile, OnboardingController } from "./onboarding-controller.ts"
import { installOnboarding } from "./onboarding.ts"
import { NotificationSettingsController } from "./notification-settings.ts"
import { DesktopNotifications } from "./notifications.ts"
import { TaskNotificationMonitor } from "@deskfleet/client/task-notification-monitor"
import { installSettings, publishLocalAgentState } from "./settings.ts"
import { WorktreeRootSettingsController } from "./worktree-root-settings.ts"
import { RemoteAgentSettingsController } from "./remote-agent-settings.ts"
import { configureApplicationDisplay } from "./application-display.ts"
import {
  installRendererDownloadGuard,
  installRendererPermissions,
  installRendererProtocol,
  registerRendererScheme,
} from "./renderer-protocol.ts"
import { createTray, destroyTray, setTrayUpdateVersion } from "./tray.ts"
import type { UpdateController } from "./update-controller.ts"
import { UpdateSettingsController } from "./update-settings.ts"
import { installUpdates, resolveDesktopInstallSource } from "./updates.ts"
import { installWindowsDesktopService } from "./windows-desktop-service.ts"
import { hideMainWindow, openMainWindowNotificationSession, showMainWindow } from "./windows.ts"
import { installApplication } from "./application.ts"
import { installGoogleTag } from "./google-tag.ts"

function start(): void {
  const linuxKeyringPath = join(app.getPath("userData"), "linux-keyring.json")
  const { appliedUseSystemKeyring, overriddenExternally } = configureLinuxPasswordStore({
    platform: process.platform,
    path: linuxKeyringPath,
    commandLine: app.commandLine,
    env: process.env,
  })
  const dshHost = electronDshHost(process.execPath)
  configureDshRuntime(app.isPackaged
    ? bundledDshRuntime(join(process.resourcesPath, "dsh"), dshHost)
    : sourceDshRuntime(join(app.getAppPath(), "package.json"), dshHost))
  registerRendererScheme()
  // Pass original process.argv so internal commandLine.appendSwitch() entries
  // (such as --password-store=basic) do not stick across restarts, and route
  // Linux AppImages through the supervisor instead of the ephemeral mount path.
  const relaunch = process.platform === "linux" && process.env.APPIMAGE
    ? () => startAppImageRestart(process.env.APPIMAGE!, process.argv.slice(1), process.env)
    : () => app.relaunch({ args: process.argv.slice(1) })
  const lifecycle = keepRunningInBackground(app, hideMainWindow, relaunch)
  installApplication(lifecycle)
  const show = () => void showMainWindow(lifecycle)
  let updates: UpdateController | undefined
  let userQuit = false
  let quittingForUpdate = false
  let relaunchOnExit = false

  const reopen = (): void => {
    if (quittingForUpdate) {
      relaunchOnExit = true
      updates?.close()
      return
    }
    show()
  }

  app.on("second-instance", reopen)

  void app.whenReady().then(async () => {
    configureApplicationDisplay(() => void showMainWindow(lifecycle, "#/settings/preferences"))
    try { refreshLaunchAtStartup() } catch (error) { console.error("Could not refresh launch at startup", error) }
    installAppearance(new AppearanceSettingsController(join(app.getPath("userData"), "appearance.json")))
    installRendererProtocol()
    installGoogleTag()
    installRendererDownloadGuard()
    installDesktopMediaIpc()
    installRendererPermissions()
    // The dev runner, service managers, and session shutdown stop the client with
    // signals. Electron's own handlers, installed during startup, request an
    // ordinary quit that the tray lifecycle blocks; registering after ready
    // replaces them.
    const abortQuitUpdate = (): void => {
      userQuit = false
      updates?.close()
      lifecycle.quit()
    }
    process.once("SIGINT", abortQuitUpdate)
    process.once("SIGTERM", abortQuitUpdate)
    // Logging out or shutting down must not wait on a client hidden in the tray.
    powerMonitor.on("shutdown", abortQuitUpdate)

    const userData = app.getPath("userData")
    const daemonDirectory = desktopDaemonDirectory()
    const workspaceDirectory = desktopWorkspaceDirectory()
    // AUV registers its Linux desktop identity in parallel with local setup;
    // the bundled binary needs that identity before agents can use it.
    const auvPath = prepareAuv({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })
    const windowsDesktopService = installWindowsDesktopService()
    void windowsDesktopService?.reconcileOnStartup().catch(error => {
      console.warn("Windows desktop service maintenance update failed", error)
    })
    const auvBinary = await auvPath
    const localAgent = new LocalAgentController(
      join(userData, "settings.json"),
      createLocalAgentRuntime({
        directory: daemonDirectory,
        workspaceDirectory,
        auvPath: auvBinary,
      }),
      publishLocalAgentState,
    )
    // AUV's Portal identity and consent are a Linux desktop concern.
    const auv = process.platform === "linux" ? new AuvPermissionsController(auvBinary) : undefined
    const keepAwake = new KeepAwakeController(join(userData, "keep-awake.json"), powerSaveBlocker)
    const onboarding = new OnboardingController({
      path: join(userData, "onboarding.json"), platform: process.platform, localAgent,
      windowsDesktopService, auv,
      localNetwork: { request: requestLocalNetworkAccess, openSettings: openLocalNetworkSettings },
      established: () => establishedDesktopProfile(userData),
    })
    installOnboarding(onboarding)

    // The hosted daemon outlives windows but not the app. Register its shutdown
    // barrier before starting the daemon or touching safeStorage so quits work
    // cleanly even while a locked Linux keyring waits for unlock.
    const closers: Array<() => void | Promise<void>> = [() => localAgent.close()]
    const syncCleanups: Array<() => void> = [() => auv?.close()]
    let closing: Promise<void> | undefined
    let servicesClosed = false
    const closeServices = (): Promise<void> => {
      for (const cleanup of syncCleanups) cleanup()
      closing ??= Promise.allSettled(closers.map(close => close())).then(results => {
        const failure = results.find(result => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
        servicesClosed = true
      }).finally(() => keepAwake.close()).catch((error: unknown) => { closing = undefined; throw error })
      return closing
    }
    app.on("will-quit", (event) => {
      // Let the updater's own quit/relaunch finish once the same shutdown barrier
      // has already completed. Ordinary exits still wait for hosted services.
      if (servicesClosed) return
      event.preventDefault()
      if (quittingForUpdate) return
      if (userQuit && updates?.canInstallOnQuit()) {
        quittingForUpdate = true
        destroyTray()
        app.dock?.hide()
        void updates.installOnQuit().then(async () => {
          if (relaunchOnExit) await relaunch()
          app.exit(0)
        }).catch((error: unknown) => {
          console.error(error)
          app.exit(1)
        })
        return
      }
      updates?.close()
      void closeServices().then(
        () => app.exit(0),
        (error: unknown) => { console.error(error); app.exit(1) },
      )
    })

    // Start Keep Awake and the hosted daemon BEFORE installCentralAccount()
    // accesses Electron safeStorage. The daemon authenticates with central.json
    // and never needs the OS keyring, so remote control, terminals, agents, and
    // files reconnect immediately even if a locked Linux keyring blocks unlock.
    try { keepAwake.get() } catch (error) { console.error(error) }
    await localAgent.initialize({ start: false })
    try {
      const { step } = await onboarding.get()
      if (step !== "account" && step !== "machineControl") await localAgent.startIfEnabled()
    } catch (error) { console.error(error) }
    if (lifecycle.quitting) return

    const central = await installCentralAccount()
    if (lifecycle.quitting) return
    const nativeDesktop = installNativeDesktop(central)
    installLocalApplications(central)
    installNetworkDiagnostics(central)
    const speech = installSpeech()
    const files = installFiles(central)
    const ports = installPorts(central)
    const localChannels = installLocalChannels(central)
    const muxChannels = installMuxChannels(central)
    closers.push(
      () => files.close(),
      () => ports.close(),
      () => localChannels.close(),
      () => muxChannels.close(),
      () => nativeDesktop.close(),
      () => speech.close(),
    )

    const notificationSettings = new NotificationSettingsController(join(userData, "notifications.json"))
    const notifications = new DesktopNotifications(notificationSettings, event => void openMainWindowNotificationSession(lifecycle, event))
    const notificationMonitor = new TaskNotificationMonitor(central, notification => notifications.notify(notification), console.error)
    syncCleanups.push(() => notificationMonitor.close(), () => notifications.close())
    if (process.platform === "win32") app.setAppUserModelId("io.github.yet-another-ai.deskfleet")
    void notificationMonitor.start().catch(console.error)

    updates = await installUpdates(lifecycle, closeServices, state => {
      setTrayUpdateVersion(state.status === "downloaded" && state.installOnQuit && state.version ? state.version : null)
    })
    const updateSettings = new UpdateSettingsController(
      join(userData, "updates.json"),
      state => updates!.setDownloadPreferences(state.enabled, state.pauseOnMetered, state.installOnQuit),
      resolveDesktopInstallSource(),
    )
    const linuxKeyring = process.platform === "linux"
      ? new LinuxKeyringSettingsController(linuxKeyringPath, appliedUseSystemKeyring, overriddenExternally)
      : undefined
    installSettings(
      localAgent,
      keepAwake,
      notificationSettings,
      new WorktreeRootSettingsController(daemonDirectory, workspaceDirectory === daemonDirectory ? daemonDirectory : join(workspaceDirectory, "worktrees")),
      updateSettings,
      new RemoteAgentSettingsController(daemonDirectory),
      linuxKeyring,
    )
    try { updateSettings.get() } catch (error) { console.error(error) }
    if (lifecycle.quitting) return
    updates.start()
    createTray({ show, quit: () => { userQuit = true; lifecycle.quit() } })
    show()
    app.on("activate", reopen)
  })
}

// A second launch focuses the running client instead of adding another tray icon.
if (app.requestSingleInstanceLock()) {
  start()
} else {
  app.quit()
}
