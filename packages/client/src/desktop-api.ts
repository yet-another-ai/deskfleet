import type { DesktopMediaApi } from "./desktop-media.ts"
import type { CatalogApi } from "./catalog.ts"
import type { FilesystemApi } from "./filesystem.ts"
import type { AppLocale } from "./i18n.ts"
import type { SettingsApi } from "./settings.ts"
import type { TerminalSignalingApi } from "./terminal.ts"
import type { AgentSignalingApi } from "./agent.ts"
import type { ProvidersApi } from "./providers.ts"

/** The preload bridge exposed to the main renderer as `window.deskfleet`. */
export interface DeskfleetDesktopApi {
  platform: "darwin" | "linux" | "win32"
  locale: AppLocale
  settings: SettingsApi
  catalog: CatalogApi
  filesystem: FilesystemApi
  desktop: DesktopMediaApi
  terminal: TerminalSignalingApi
  agent: AgentSignalingApi
  providers: ProvidersApi
}
