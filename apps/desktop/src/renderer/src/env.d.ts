import type { DeskfleetDesktopApi } from "../../../../../packages/client/src/desktop-api.ts"

declare global {
  interface Window {
    deskfleet: DeskfleetDesktopApi
  }
}

export {}
