import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAsset, isSea } from "node:sea"
import type { DisplayInfo, LocalApplication, LocalNetworkAccessRequest, NativeCatalog, NativeInfo, NativePeer, NativeTerminal, PeerConfig, SystemStatus, TerminalConfig, LinuxDesktopAccess } from "./bindings.d.ts"

export type { DesktopConfig, DisplayInfo, IceCandidate, IceServer, MediaFailure, NativeInfo, NativePeer, NativeTerminal, PeerConfig, PeerEvent, TerminalConfig, TerminalEvent, VideoCodec, LinuxDesktopAccess } from "./bindings.d.ts"
export type { CatalogDirectory, CatalogSnapshot, CatalogWorkspace, CatalogWorkspaceSession, CatalogWorktree, NativeCatalog } from "./bindings.d.ts"
export type { SystemStatus } from "./bindings.d.ts"
export type { LocalApplication, LocalApplicationKind } from "./bindings.d.ts"
export type { LocalNetworkAccessRequest } from "./bindings.d.ts"

type Bindings = typeof import("./bindings.d.ts")
let bindings: Bindings | undefined

function loadBindings(): Bindings {
  const addon = { exports: {} as Bindings }
  if (!isSea()) {
    process.dlopen(addon, join(import.meta.dirname, "deskfleet.node"))
    return addon.exports
  }

  const asset = Buffer.from(getAsset("deskfleet.node"))
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-native-"))
  const filename = join(directory, "deskfleet.node")
  try {
    writeFileSync(filename, asset, { flag: "wx", mode: 0o600 })
    process.dlopen(addon, filename)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }

  if (process.platform === "win32") {
    process.once("exit", () => {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch (error) {
        // Windows can keep the DLL mapped until process teardown completes.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error
      }
    })
  } else {
    rmSync(directory, { recursive: true, force: true })
  }
  return addon.exports
}

export function nativeInfo(): NativeInfo {
  return (bindings ??= loadBindings()).nativeInfo()
}

/** Read machine CPU and memory usage on a native worker. */
export function systemStatus(): Promise<SystemStatus> {
  return (bindings ??= loadBindings()).systemStatus()
}

/** Discover supported applications installed on this desktop client. */
export function scanLocalApplications(): Promise<LocalApplication[]> {
  return (bindings ??= loadBindings()).scanLocalApplications()
}

/** Open one local directory using a supported, installed application. */
export function openLocalApplication(applicationId: string, directory: string): Promise<void> {
  return (bindings ??= loadBindings()).openLocalApplication(applicationId, directory)
}

export function createPeer(config: PeerConfig = {}): Promise<NativePeer> {
  return (bindings ??= loadBindings()).createPeer(config)
}

export function createTerminal(config: TerminalConfig): Promise<NativeTerminal> {
  return (bindings ??= loadBindings()).createTerminal(config)
}

export function openCatalog(databasePath: string, machineName: string): Promise<NativeCatalog> {
  return (bindings ??= loadBindings()).openCatalog(databasePath, machineName)
}

export function openInMemoryCatalog(machineName: string): Promise<NativeCatalog> {
  return (bindings ??= loadBindings()).openInMemoryCatalog(machineName)
}

export function supportedVideoCodecs(displayId: number): Promise<string[]> {
  return (bindings ??= loadBindings()).supportedVideoCodecs(displayId)
}

export function captureDisplays(): Promise<DisplayInfo[]> {
  return (bindings ??= loadBindings()).captureDisplays()
}

/** Check the daemon's Full Disk Access without opening macOS settings; null elsewhere. */
export function checkFullDiskAccess(): Promise<boolean | null> {
  return (bindings ??= loadBindings()).checkFullDiskAccess()
}

/** Check screen recording access without prompting or starting capture; null elsewhere. */
export function checkScreenCaptureAccess(): Promise<boolean | null> {
  return (bindings ??= loadBindings()).checkScreenCaptureAccess()
}

/** Check Accessibility without prompting or opening an input controller; null elsewhere. */
export function checkAccessibilityAccess(): Promise<boolean | null> {
  return (bindings ??= loadBindings()).checkAccessibilityAccess()
}

/** Check the daemon's Full Disk Access and open macOS settings if needed; null elsewhere. */
export function requestFullDiskAccess(): Promise<boolean | null> {
  return (bindings ??= loadBindings()).requestFullDiskAccess()
}

/** Request permission in the calling process; null means no upfront request on this platform. */
export function requestScreenCaptureAccess(): Promise<boolean | null> {
  return (bindings ??= loadBindings()).requestScreenCaptureAccess()
}

/** Request Accessibility in the daemon's process without opening an input controller. */
export function requestAccessibilityAccess(): Promise<boolean | null> {
  return (bindings ??= loadBindings()).requestAccessibilityAccess()
}

/** Try to trigger macOS local-network consent; the outcome never confirms a grant. */
export function requestLocalNetworkAccess(): Promise<LocalNetworkAccessRequest> {
  return (bindings ??= loadBindings()).requestLocalNetworkAccess()
}

/** Open macOS Local Network settings for this desktop app; a no-op elsewhere. */
export function openLocalNetworkSettings(): Promise<void> {
  return (bindings ??= loadBindings()).openLocalNetworkSettings()
}

/** The native-selected desktop backend; absent outside an interactive Linux session. */
export function linuxDesktopBackend(): "wayland" | "x11" | null {
  return (bindings ??= loadBindings()).linuxDesktopBackend()
}

/** Authorize Wayland or check X11 screen/input access during daemon startup. */
export function requestLinuxDesktopAccess(directory: string): Promise<LinuxDesktopAccess> {
  return (bindings ??= loadBindings()).requestLinuxDesktopAccess(directory)
}

/** Check Linux desktop access without opening a consent dialog. */
export function checkLinuxDesktopAccess(): Promise<LinuxDesktopAccess> {
  return (bindings ??= loadBindings()).checkLinuxDesktopAccess()
}

/** Wait until Wayland access changes, or until desktop shutdown. */
export function waitLinuxDesktopAccessChange(seen: number): Promise<number | null> {
  return (bindings ??= loadBindings()).waitLinuxDesktopAccessChange(seen)
}

/** Close the daemon's Linux desktop access resources. */
export function closeLinuxDesktopAccess(): Promise<void> {
  return (bindings ??= loadBindings()).closeLinuxDesktopAccess()
}

/** Discover platform desktop support without opening a consent dialog. */
export function desktopSupported(): Promise<boolean> {
  return (bindings ??= loadBindings()).desktopSupported()
}
