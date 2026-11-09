export interface NativeDesktopOptions {
  displayId: number
  control: boolean
  locale?: string
  theme?: "light" | "dark"
}

export interface NativeDesktopRequest extends NativeDesktopOptions {
  target: { teamId: string; machineId: string }
}

/** An independent viewer owned by the desktop application, not a renderer tab. */
export interface NativeDesktopApi {
  open(request: NativeDesktopRequest): Promise<void>
}

export const NATIVE_DESKTOP_CHANNEL = "deskfleet:native-desktop"
