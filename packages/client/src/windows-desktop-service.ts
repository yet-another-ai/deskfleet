export const WINDOWS_DESKTOP_SERVICE_CHANNEL = "deskfleet:windows-desktop-service"

export interface WindowsDesktopServiceState {
  available: boolean
  installed: boolean
  running: boolean
  maintenanceInstalled?: boolean
  updateAvailable?: boolean
  silentUpdateAvailable?: boolean
}

/** Local Windows host setup; installing the service does not grant remote access. */
export interface WindowsDesktopServiceApi {
  get(): Promise<WindowsDesktopServiceState>
  setEnabled(enabled: boolean): Promise<WindowsDesktopServiceState>
  update?(): Promise<WindowsDesktopServiceState>
}
