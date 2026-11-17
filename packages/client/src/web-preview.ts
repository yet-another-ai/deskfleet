export const WEB_PREVIEW_IPC_CHANNEL = "deskfleet:web-preview"

/** Main-process origin guards and detached DevTools for Session Web Preview. */
export interface WebPreviewDesktopApi {
  allowOrigin(origin: string): Promise<string>
  revokeOrigin(grantId: string): Promise<void>
  openDevTools(guestWebContentsId: number): Promise<void>
}
