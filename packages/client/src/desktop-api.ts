import type { CentralApi, SiteAdministrationApi } from "./central.ts"
import type { DesktopMediaApi } from "./desktop-media.ts"
import type { CatalogApi } from "./catalog.ts"
import type { FilesystemApi } from "./filesystem.ts"
import type { FilesApi } from "./files.ts"
import type { PortsApi } from "./ports.ts"
import type { AppLocale } from "./i18n.ts"
import type { SettingsApi } from "./settings.ts"
import type { TerminalSignalingApi } from "./terminal.ts"
import type { AgentSignalingApi } from "./agent.ts"
import type { ProvidersApi } from "./providers.ts"
import type { OnboardingApi } from "./onboarding.ts"
import type { SystemApi } from "./system.ts"
import type { AppearanceApi } from "./appearance.ts"

/** The preload bridge exposed to the main renderer as `window.deskfleet`. */
export interface DeskfleetDesktopApi {
  platform: "darwin" | "linux" | "win32" | "web"
  central?: CentralApi
  /** Only the Web host exposes site administration. */
  siteAdministration?: SiteAdministrationApi
  onboarding?: OnboardingApi
  appearance?: AppearanceApi
  initialError?: string
  target?: { id: string; local: boolean; lastSeen?: string }
  locale: AppLocale
  settings: SettingsApi
  catalog: CatalogApi
  filesystem: FilesystemApi
  files?: FilesApi
  ports?: PortsApi
  desktop: DesktopMediaApi
  terminal: TerminalSignalingApi
  agent: AgentSignalingApi
  providers: ProvidersApi
  system?: SystemApi
}
