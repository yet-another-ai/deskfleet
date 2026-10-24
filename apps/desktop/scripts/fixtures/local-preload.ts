import { contextBridge } from "electron"
import { desktopApi } from "../../src/preload/api.ts"
import { isMainRendererUrl } from "../../src/shared/renderer-security.ts"

// Test-only local transport. Production always installs the account adapter.
if (isMainRendererUrl(globalThis.location.href)) contextBridge.exposeInMainWorld("deskfleet", desktopApi())
