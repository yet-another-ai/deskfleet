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
import type { LocalApplicationsApi } from "./applications.ts"
import type { UpdateApi } from "./updates.ts"
import type { LocalChannelsApi } from "./local-channels.ts"
import type { MuxChannelsApi } from "./mux-channels.ts"
import type { WindowsDesktopServiceApi } from "./windows-desktop-service.ts"
import type { NativeDesktopApi } from "./native-desktop.ts"
import type { NetworkDiagnosticsApi } from "./network-diagnostics.ts"
import type { OutlineAudioApi } from "./outline-audio.ts"
import type { ApplicationApi } from "./application.ts"
import type { SpeechApi } from "./speech.ts"

import type { SuperMethods, SuperHistory, SuperHistoryRequest } from "../../../apps/daemon/src/super-agent-protocol.ts"

export type SuperAgentApi = { history?: (params: SuperHistoryRequest) => Promise<SuperHistory> } & {
  [Name in keyof SuperMethods as Name extends `_deskfleet/super-agent/${infer Action}` ? Action : never]:
    (params: SuperMethods[Name]["params"]) => Promise<SuperMethods[Name]["result"]>
}

/** The host platform adapter configured for the shared application. */
export interface DeskfleetDesktopApi {
  superAgent?: SuperAgentApi
  /** This client can navigate projects on enrolled remote machines without a local daemon. */
  remoteWorkspaceAgent?: boolean
  platform: "darwin" | "linux" | "win32" | "web"
  /** True when running inside the native mobile client (Android / iOS). */
  mobile?: boolean
  /** Adjust native interface text without zooming the viewport or scaling controls. */
  setInterfaceTextScale?(percent: number): void
  central?: CentralApi
  /** Only the Web host exposes site administration. */
  siteAdministration?: SiteAdministrationApi
  onboarding?: OnboardingApi
  appearance?: AppearanceApi
  applications?: LocalApplicationsApi
  updates?: UpdateApi
  windowsDesktopService?: WindowsDesktopServiceApi
  nativeDesktop?: NativeDesktopApi
  networkDiagnostics?: NetworkDiagnosticsApi
  outlineAudio?: OutlineAudioApi
  application?: ApplicationApi
  speech?: SpeechApi
  haptic?: (kind: "activate" | "tick") => void
  onOpenNotificationSession?: (listener: (target: { teamId: string; machineId: string; sessionId: string }) => void) => () => void
  initialError?: string
  target?: { id: string; teamId?: string; local: boolean; lastSeen?: string }
  localChannels?: LocalChannelsApi
  muxChannels?: MuxChannelsApi
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
