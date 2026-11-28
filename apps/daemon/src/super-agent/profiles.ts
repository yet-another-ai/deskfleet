import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { codexCoordinatorSelection, listSuperCodexModels, supportsCodexCoordinatorVersion } from "./codex.ts"
import type { SuperModelLaunch } from "./router.ts"
import { restrictedClaudeArgs, superModelBinary } from "./model.ts"
import type { SuperCoordinator, SuperCoordinatorOptions, SuperModelSelection } from "@deskfleet/protocol/super-agent"

const exec = promisify(execFile)
const unavailable: SuperCoordinatorOptions = { models: [], defaultReasoningEfforts: [] }

async function codexOptions(cwd: string, launch?: SuperModelLaunch): Promise<SuperCoordinatorOptions> {
  if (process.platform !== "darwin") return unavailable
  const binary = await superModelBinary("codex", launch)
  const version = await exec(binary, ["--version"], { cwd, env: launch?.env, timeout: 5000 })
  if (!supportsCodexCoordinatorVersion(version.stdout.trim())) return unavailable
  const models = (await listSuperCodexModels(binary, cwd, launch?.env ?? process.env)).map(model => ({
    id: model.slug, name: model.display_name, defaultReasoningEffort: model.default_reasoning_level,
    reasoningEfforts: model.supported_reasoning_levels.map(level => level.effort),
  }))
  const defaultModel = models.find(model => model.id === codexCoordinatorSelection.model)
  return { models, defaultModel: defaultModel?.id, defaultReasoningEfforts: defaultModel?.reasoningEfforts ?? [] }
}

async function claudeOptions(cwd: string, launch?: SuperModelLaunch): Promise<SuperCoordinatorOptions> {
  const binary = await superModelBinary("claude", launch)
  // initialize queries the CLI's local model picker. No user message or completion is submitted.
  const child = exec(binary, [...restrictedClaudeArgs, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { cwd, env: launch?.env, timeout: 8000, maxBuffer: 2 * 1024 * 1024 })
  child.child.stdin?.on("error", () => { /* handled on exit */ })
  child.child.stdin?.end(JSON.stringify({ type: "control_request", request_id: "coordinator-models", request: { subtype: "initialize" } }) + "\n")
  const { stdout } = await child
  type Model = { value: string; displayName: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }
  const frame = stdout.trim().split("\n").map(line => JSON.parse(line)).find(item =>
    item.type === "control_response" && item.response?.request_id === "coordinator-models")
  const choices: Model[] = frame?.response?.response?.models ?? []
  const levels = (model?: Model) => model?.supportsEffort ? model.supportedEffortLevels?.filter(id => typeof id === "string") ?? [] : []
  return { models: choices.filter(item => item.value !== "default").map(item => ({
    id: item.value, name: item.displayName, reasoningEfforts: levels(item),
  })), defaultReasoningEfforts: levels(choices.find(item => item.value === "default")) }
}

export async function queryCliCoordinatorOptions(template: string, launch?: SuperModelLaunch): Promise<SuperCoordinatorOptions> {
  const cwd = await mkdtemp(join(tmpdir(), "deskfleet-coordinator-models-"))
  try {
    if (template === "codex") return await codexOptions(cwd, launch)
    if (template === "claude-code") return await claudeOptions(cwd, launch)
    return unavailable
  } finally { await rm(cwd, { recursive: true, force: true }) }
}

export function effectiveCoordinatorProfile(provider: SuperCoordinator, overrides: SuperModelSelection, options: SuperCoordinatorOptions): SuperModelSelection {
  if (provider !== "codex") return { ...overrides }
  const model = overrides.model ?? options.defaultModel
  if (!model) return { ...overrides }
  const available = options.models.find(entry => entry.id === model)
  const defaultEffort = model === codexCoordinatorSelection.model && (!available || available.reasoningEfforts.includes("low"))
    ? codexCoordinatorSelection.reasoningEffort : available?.defaultReasoningEffort
  return { model, reasoningEffort: overrides.reasoningEffort ?? defaultEffort }
}

export function validateCoordinatorProfile(selection: SuperModelSelection, options: SuperCoordinatorOptions) {
  const model = options.models.find(entry => entry.id === selection.model)
  if (selection.model && !model) throw new Error("The installed coordinator does not offer this model")
  if (selection.reasoningEffort && !(model?.reasoningEfforts ?? options.defaultReasoningEfforts).includes(selection.reasoningEffort)) {
    throw new Error("The selected coordinator model does not offer this reasoning effort")
  }
}
