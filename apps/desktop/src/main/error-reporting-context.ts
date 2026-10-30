import { app } from "electron"
import type { DesktopErrorReportingContext } from "@deskfleet/client/error-reporting-context"

/** Electron supplies the product OS version, including macOS rather than its Darwin kernel. */
export function desktopErrorReportingContext(): DesktopErrorReportingContext {
  const names: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", win32: "Windows", linux: "Linux" }
  return {
    os: { name: names[process.platform] ?? process.platform, version: process.getSystemVersion() },
    architecture: process.arch,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  }
}
