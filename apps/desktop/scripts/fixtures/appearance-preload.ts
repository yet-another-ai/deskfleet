import { contextBridge } from "electron"
import { desktopApi } from "../../src/preload/api.ts"
import { isMainRendererUrl } from "../../src/shared/renderer-security.ts"

// The smoke uses the real appearance bridge and an offline machine, without a daemon.
const api = desktopApi()
api.desktop.target = async () => ({ id: "local-daemon", name: "Appearance smoke", online: false, desktop: false })
api.catalog.list = async () => { throw new Error("Offline smoke machine") }
api.terminal.list = async () => []
api.settings.get = async () => ({ enabled: false, status: "stopped" })
api.settings.getLaunchAtStartup = async () => ({ available: false, enabled: false })
api.settings.getKeepAwake = async () => ({ enabled: false })
api.settings.getWorktreeRoot = async () => ({ root: null, defaultRoot: "/smoke/worktrees" })
if (isMainRendererUrl(globalThis.location.href)) contextBridge.exposeInMainWorld("deskfleet", api)
