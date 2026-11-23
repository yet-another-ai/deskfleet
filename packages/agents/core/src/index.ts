export { canContinueSession, connectAcpProcess, standardAcpProvider, supportsSteering } from "./acp.ts"
export { configureAdapterFallbackEntry, configureAdapterHost, hostedProcess } from "./adapter-host.ts"
export { agentAuthStatus, AUTH_STATUS_UPDATE_METHOD } from "./auth-status.ts"
export { createAcpFilesystem } from "./filesystem.ts"
export {
  assertSupportedMcpFields, buildStdioMcpServer, discoverProjectTableWorkspaces, invalidMcpConfigError, isRecord,
  mcpEnvVariable, McpImportError, mergeConfigTables, parseMcpString, parseMcpStringMap, parseMcpStrings,
  readStructuredConfig, requiredMcpEnvVariable, setCaseInsensitiveHeader, type McpImportContext,
} from "./mcp-helpers.ts"
export {
  interactiveProviderProcess, launchProviderCommand, runProbeCommand, type ProbeCommand, type ProbeCommandResult,
} from "./process.ts"
export {
  findReasoningEffortOption, REASONING_CONFIG_IDS, selectChoiceValues,
  type AgentAuthStatus, type AgentComposerCatalog, type AgentComposerCommand, type AgentComposerSkill,
  type AgentComposerSkillParser, type AgentProviderTemplateMetadata, type AgentQuotaItem, type McpServerInput,
  type McpServerSettings, type ProviderMcpServerCandidate, type ProviderMcpServerDiscovery,
  type ProviderProbeResult, type ProviderWorkspaceCandidate, type ProviderWorkspaceDiscovery,
} from "@deskfleet/protocol/agents/core"
export {
  buildQuestionForm, isQuestionRecord, nonEmptyText, parseQuestionFlag, parseQuestionOptions, selectedQuestionValues,
  type VendorParsedQuestion, type VendorParsedQuestions, type VendorQuestionOption,
} from "./question-form.ts"
export { AcpModelReasoning, projectModelReasoning, type ReasoningSource } from "./reasoning-effort.ts"
export { AcpSessionModes, withRestoredSessionMode } from "./session-modes.ts"
export { AcpSessionScope } from "./session-scope.ts"
export {
  commandCandidates, compareSemverVersions, extractSemverVersion, findBash, findCommand, findPowerShell,
  jsonVersionParser, npmLocations, resolveBashScriptInstaller, resolvePowerShellScriptInstaller,
  resolveStandardUrlInstaller, stripAnsiText, supportsAutoInstallPlatform, UNSUPPORTED_INSTALL_PLATFORM_MESSAGE,
} from "./setup-helpers.ts"
export type {
  AcpConnectOptions, AcpExtension, AcpExtensionContext, AcpTerminalController, AgentClient, AgentConfig,
  AgentConnection, AgentProcess, AgentProvider, AgentProviderPlugin, AgentTerminalHandler, BundledAdapterSpec,
  ProviderInstallerLaunch, ProviderMcpDiscoveryContext, ProviderSetupContext, ProviderSetupSpec, ProviderUpdateSpec,
  ProviderVersionSource, ProviderWorkspaceDiscoveryContext, SteeringOutcome,
} from "./types.ts"
export { clampQuota, providerProcessEnv, runJsonLineExchange, runUsageJsonCommand } from "./usage.ts"
