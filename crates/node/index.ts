import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAsset, isSea } from "node:sea"
import type { DisplayInfo, NativeCatalog, NativeInfo, NativePeer, NativeTerminal, PeerConfig, TerminalConfig, WaylandDesktopAccess } from "./bindings.d.ts"

export type { DesktopConfig, DisplayInfo, IceCandidate, IceServer, MediaFailure, NativeInfo, NativePeer, NativeTerminal, PeerConfig, PeerEvent, TerminalConfig, TerminalEvent, VideoCodec, WaylandDesktopAccess } from "./bindings.d.ts"
export type { CatalogDirectory, CatalogSnapshot, CatalogWorkspace, CatalogWorkspaceSession, CatalogWorktree, NativeCatalog } from "./bindings.d.ts"

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

/** Authorize or restore one shared screen/input Portal session during startup. */
export function requestWaylandDesktopAccess(directory: string): Promise<WaylandDesktopAccess> {
  return (bindings ??= loadBindings()).requestWaylandDesktopAccess(directory)
}

/** Check the existing Portal session without opening a consent dialog. */
export function checkWaylandDesktopAccess(): Promise<WaylandDesktopAccess> {
  return (bindings ??= loadBindings()).checkWaylandDesktopAccess()
}

/** Wait until the shared Portal grant changes, or until desktop shutdown. */
export function waitWaylandDesktopAccessChange(seen: number): Promise<number | null> {
  return (bindings ??= loadBindings()).waitWaylandDesktopAccessChange(seen)
}

/** Cancel pending Portal requests and close the daemon's shared desktop session. */
export function closeWaylandDesktopAccess(): Promise<void> {
  return (bindings ??= loadBindings()).closeWaylandDesktopAccess()
}

/** Discover platform desktop support without opening a consent dialog. */
export function desktopSupported(): Promise<boolean> {
  return (bindings ??= loadBindings()).desktopSupported()
}
