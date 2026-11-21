export const WEB_PREVIEW_IPC_CHANNEL = "deskfleet:web-preview"

/** Desktop-only detached DevTools bridge for Session Web Preview. */
export interface WebPreviewDesktopApi {
  openDevTools(guestWebContentsId: number): Promise<void>
}
