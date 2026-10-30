import type { DesktopPreloadApi } from "../../shared/preload-api.ts"

declare global {
  interface Window {
    deskfleet: DesktopPreloadApi
  }
}

export {}
