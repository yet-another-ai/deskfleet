import type { posix } from "node:path"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import type {
  AgentAuthStatus,
  AgentComposerSkillParser,
  AgentProviderTemplateMetadata,
  AgentQuotaItem,
  McpServerInput,
  ProviderMcpServerDiscovery,
  ProviderProbeResult,
  ProviderWorkspaceDiscovery,
} from "./protocol.ts"
import type { ProbeCommand } from "./process.ts"

export interface AgentConfig {
  name: string
  binaryPath?: string
  env?: Record<string, string>
  /** Connection-local primary worktree (or probe) directory, supplied before initialization. */
  cwd?: string
  /** Host-owned bundled commands, also supplied to daemon-hosted ACP terminals. */
  commandDirectory?: string
  /** Connection checks may consume existing credentials but must never start login. */
  authentication?: "existing"
}

export interface AgentProvider {
  readonly id: string
  connect(config: AgentConfig, client: AgentClient): Promise<AgentConnection>
  readUsage?(config: AgentConfig, signal?: AbortSignal): Promise<AgentQuotaItem[]>
}

export interface AgentProcess {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface AcpTerminalController {
  checkpoint(): Set<string>
  rollback(checkpoint: Set<string>): Promise<void>
  create(params: acp.CreateTerminalRequest, signal?: AbortSignal): Promise<acp.CreateTerminalResponse>
  output(params: acp.TerminalOutputRequest, signal?: AbortSignal): Promise<acp.TerminalOutputResponse>
  waitForExit(params: acp.WaitForTerminalExitRequest, signal?: AbortSignal): Promise<acp.WaitForTerminalExitResponse>
  kill(params: acp.KillTerminalRequest, signal?: AbortSignal): Promise<acp.KillTerminalResponse>
  release(params: acp.ReleaseTerminalRequest, signal?: AbortSignal): Promise<acp.ReleaseTerminalResponse>
  close(): Promise<void>
}

export interface AgentTerminalHandler {
  cwd?: string
  env?: Record<string, string>
  createController(
    requireSession: (sessionId: string) => void,
    sessionCwd?: (sessionId: string) => string | undefined,
    env?: Record<string, string>,
  ): AcpTerminalController
}

export interface AgentClient {
  signal?: AbortSignal
  terminals?: AgentTerminalHandler
  /** Opt in only when the consumer projects these structured events or options. */
  capabilities?: { configOptions?: boolean; compaction?: boolean; notices?: boolean; plans?: boolean; subagents?: boolean }
  onUpdate(notification: acp.SessionNotification): void | Promise<void>
  /** Restore known descendant ownership without publishing replayed conversation events. */
  onSubagentSession?(sessionId: string): void
  onAuthStatus?(status: AgentAuthStatus): void | Promise<void>
  onClose?(reason: Error): void
  requestPermission?(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>
  requestElicitation?(
    params: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>
  completeElicitation?(params: acp.CompleteElicitationNotification): void | Promise<void>
}

export interface AgentConnection {
  readonly initialization: acp.InitializeResponse
  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>
  forkSession?(params: acp.ForkSessionRequest): Promise<acp.ForkSessionResponse>
  /** knownOptions restores setter identity after resume; it is never sent over ACP. */
  setConfigOption(params: acp.SetSessionConfigOptionRequest, knownOptions?: acp.SessionConfigOption[]): Promise<acp.SetSessionConfigOptionResponse>
  resume(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse>
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>
  /** Never starts a detached provider turn. Inactive inputs need a normal prompt. */
  steer(params: acp.PromptRequest, deliveryId: string): Promise<SteeringOutcome>
  cancel(sessionId: string): Promise<void>
  close(): Promise<void>
}

export type SteeringOutcome = { outcome: "injected" | "inactive" }

export interface AcpExtensionContext {
  getSessionId(): string | undefined
  cwd?: string
  capabilities?: AgentClient["capabilities"]
  onUpdate(notification: acp.SessionNotification): void | Promise<void>
  requestElicitation?: NonNullable<AgentClient["requestElicitation"]>
  close(error?: unknown): void
}

/** Provider-specific ACP protocol extensions registered onto a connection. */
export interface AcpExtension {
  /** Extra `_meta` keys carrying session configuration option lists (e.g., `x.ai/sessionConfig`). */
  sessionConfigMetaKeys?: readonly string[]
  /** Vendor JSON-RPC notification methods. */
  notifications?: Record<string, (params: unknown, ctx: AcpExtensionContext) => void | Promise<void>>
  /** Vendor JSON-RPC request methods (registered when elicitation or extension requests apply). */
  requests?: Record<string, (params: unknown, signal: AbortSignal, ctx: AcpExtensionContext) => Promise<unknown>>
  /** When true, request handlers are registered only if the client supplies `requestElicitation`. */
  requestsRequireElicitation?: boolean
}

export interface AcpConnectOptions {
  /** Runs after version negotiation, before callers can create a session. */
  afterInitialize?(initialization: acp.InitializeResponse, agent: acp.ClientContext): Promise<void>
  /** Merged into initialize `clientCapabilities`. Elicitation is added when the client handles forms. */
  clientCapabilities?: acp.ClientCapabilities
  /** Vendor-specific ACP extensions for this connection. */
  extensions?: readonly AcpExtension[]
}

export interface BundledAdapterSpec {
  readonly argument: string
  run(): Promise<void>
}

export interface ProviderSetupContext {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  home: string
  cwd: string
  path: typeof posix
  run: (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs?: number) => ReturnType<ProbeCommand>
  executable: (path: string) => Promise<boolean>
}

export interface ProviderInstallerLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export interface ProviderSetupSpec {
  /** Override total probe timeout for this provider (defaults to 10s). */
  probeTimeoutMs?(input: { binaryPath?: string }): number | undefined
  /** Extra search directories checked after PATH during executable discovery. */
  searchDirectories?(ctx: ProviderSetupContext): string[]
  /** Default command names to probe when binaryPath is unset (defaults to [template.defaultBinaryPath]). */
  defaultCommands?: readonly string[]
  /** Optional custom probe handler (e.g., bundled runtime without an external binary). */
  probeCustom?(input: { binaryPath?: string }, ctx: ProviderSetupContext, base: Pick<ProviderProbeResult, "auth" | "installable" | "loginAvailable" | "installMessage">): Promise<ProviderProbeResult | undefined>
  /** Optional executable validation before identity probing (returns error message to reject). */
  validateBinary?(binary: string, ctx: ProviderSetupContext): string | undefined
  /** Timeout for `--version` / `--help` identity commands. */
  identityCommandTimeoutMs?: number
  /** Regex matching `--version` or `--help` output to confirm executable identity. */
  identityPattern: RegExp
  /** Whether interactive login is available for a found external binary (defaults to true). */
  loginAvailableForBinary?: boolean
  /** Read-only authentication status check. */
  checkAuth?(binary: string, ctx: ProviderSetupContext): Promise<ProviderProbeResult["auth"]>
  /** Resolve official installer command, or return an explanatory unavailability message. */
  resolveInstaller(ctx: ProviderSetupContext): Promise<{ command: string; args: string[] } | string>
  /** Adjust installer launch for non-interactive background upgrades. */
  nonInteractiveInstaller?(launch: { command: string; args: string[] }, ctx: ProviderSetupContext): { command: string; args: string[]; env: NodeJS.ProcessEnv }
  /** Build interactive login process launch (or throw an error if login is unavailable). */
  resolveLogin(binary: string | undefined, input: { binaryPath?: string }, probeResult: ProviderProbeResult, ctx: ProviderSetupContext): AgentProcess
}

export interface ProviderVersionSource {
  url: string
  parse: (body: string) => string | undefined
}

export interface ProviderUpdateSpec {
  /** Upstream release version source for this platform/arch. */
  versionSource(platform: NodeJS.Platform, arch: string): ProviderVersionSource
  /** Optional custom version extraction (defaults to SemVer). */
  extractVersion?(cleaned: string): string | undefined
  /** Optional custom version ordering (defaults to SemVer collator). */
  compareVersions?(current: string, latest: string): number
  /** Optional custom newer check (defaults to `compareVersions(current, latest) < 0`). */
  isVersionNewer?(current: string, latest: string): boolean
}

export interface ProviderWorkspaceDiscoveryContext {
  platform: NodeJS.Platform
  path: typeof posix
  env: NodeJS.ProcessEnv
  home: string
  cwd: string
}

export interface ProviderMcpDiscoveryContext extends ProviderWorkspaceDiscoveryContext {
  executable?: (path: string) => Promise<boolean>
  validateServer: (server: McpServerInput) => McpServerInput
}

/** Complete plugin contract for a built-in DeskFleet agent provider package. */
export interface AgentProviderPlugin<Id extends string = string> {
  readonly id: Id
  readonly template: AgentProviderTemplateMetadata<Id>
  readonly provider: AgentProvider
  readonly bundledAdapter?: BundledAdapterSpec
  normalizeBinaryPath?(rawBinaryPath: string): string | undefined
  resolveEnvironment?(input: { binaryPath?: string; env: Record<string, string> }, directory?: string, platform?: NodeJS.Platform): Record<string, string>
  parseComposerSkill?: AgentComposerSkillParser
  readonly setup?: ProviderSetupSpec
  readonly update?: ProviderUpdateSpec
  discoverWorkspaces?(ctx: ProviderWorkspaceDiscoveryContext): Promise<ProviderWorkspaceDiscovery>
  discoverMcpServers?(ctx: ProviderMcpDiscoveryContext): Promise<ProviderMcpServerDiscovery>
}
