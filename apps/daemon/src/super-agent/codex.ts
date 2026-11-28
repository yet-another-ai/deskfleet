import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { codexSuperUsage } from "./usage.ts"
import { superDecisionInstructions, superDecisionSchema, superModelBinary } from "./model.ts"
import type { SuperModelSelection } from "@deskfleet/protocol/super-agent"
import type { SuperImage } from "./attachments.ts"
import type { SuperDecisionModel } from "./router.ts"

const exec = promisify(execFile)
const sandbox = "/usr/bin/sandbox-exec"
// The CLI always attempts to load user-level AGENTS.md, even with project_doc_max_bytes=0.
export function superCodexSandboxArgs(binary: string, args: string[]): string[] {
  return ["-p", '(version 1)(allow default)(deny file-read* (regex #"/(AGENTS([.]override)?|SKILL)[.]md$"))', binary, ...args]
}
/** The bundled catalog and tool capabilities depend on the CLI version. Verify outgoing requests before advancing it. */
const verifiedVersions = ["0.170.0", "0.171.0"]
export function supportsCodexCoordinatorVersion(version: string): boolean {
  return verifiedVersions.some(verified => version === `codex-cli ${verified}`)
}
export const codexCoordinatorSelection = { model: "gpt-6.2-sol", reasoningEffort: "low" } as const
const disabled = [
  "shell_tool", "unified_exec", "view_image", "hooks", "plugins", "remote_plugin", "apps", "multi_agent", "browser_use",
  "browser_use_external", "computer_use", "image_generation", "tool_suggest", "goals", "sleep_tool", "skill_search", "memories",
  "incremental_tools_legacy", "incremental_tools_legacy_gcp", "multi_agent_v2", "code_mode", "code_mode_only", "shell_snapshot", "code_mode_host", "daemon_auto_start", "workspace_dependencies", "enable_request_compression", "incremental_tools",
]
const settings = [
  'approval_policy="never"', 'web_search="disabled"', "tools.experimental_request_user_input.enabled=false",
  "tools.update_plan.enabled=false", "project_doc_max_bytes=0", "skills.include_instructions=false", "skills.bundled.enabled=false",
  "include_environment_context=false", "include_apps_instructions=false", "include_collaboration_mode_instructions=false",
  "include_permissions_instructions=false", 'history.persistence="none"',
]

export function superCodexArgs(schemaFile: string, instructionsFile: string, resultFile: string, catalogFile: string, selection: SuperModelSelection = codexCoordinatorSelection): string[] {
  return ["--no-daemon", "exec", "--strict-config", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--ephemeral", "--sandbox", "read-only", "-m", selection.model ?? codexCoordinatorSelection.model,
    ...disabled.flatMap(flag => ["--disable", flag]), ...settings.flatMap(setting => ["-c", setting]),
    ...(selection.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(selection.reasoningEffort)}`] : []),
    "-c", `model_catalog_json=${JSON.stringify(catalogFile)}`, "-c", `model_instructions_file=${JSON.stringify(instructionsFile)}`, "--output-schema", schemaFile, "--json", "-o", resultFile, "-"]
}

type Schema = { [key: string]: unknown; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[]; items?: Schema; enum?: string[] }
/** The Responses strict schema requires every object key. Nullable fields translate back to our optional protocol fields. */
function strictSchema(schema: Schema): Schema {
  if (schema.properties) {
    const properties: Record<string, Schema> = {}
    for (const [key, child] of Object.entries(schema.properties)) {
      const value = strictSchema(child)
      properties[key] = schema.required?.includes(key) ? value : { anyOf: [value, { type: "null" }] }
    }
    return { ...schema, properties, required: Object.keys(properties) }
  }
  if (schema.anyOf) return { ...schema, anyOf: schema.anyOf.map(strictSchema) }
  if (schema.items) return { ...schema, items: strictSchema(schema.items) }
  if (schema.enum && !schema.type) return { ...schema, type: "string" }
  return schema
}
interface CodexCatalogModel {
  slug: string; display_name: string; default_reasoning_level: string; supported_reasoning_levels: { effort: string }[]
  visibility: string; supported_in_api: boolean
}
export async function listSuperCodexModels(binary: string, cwd: string, env: NodeJS.ProcessEnv): Promise<CodexCatalogModel[]> {
  const { stdout } = await exec(binary, ["debug", "models", "--bundled"], { cwd, env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  // Ultra combines a lower base effort with automatic delegation. Delegation is disabled in the coordinator.
  return (JSON.parse(stdout) as { models: CodexCatalogModel[] }).models
    .filter(model => model.visibility === "list" && model.supported_in_api)
    .map(model => ({ ...model, supported_reasoning_levels: model.supported_reasoning_levels.filter(level => level.effort !== "ultra") }))
}
export async function writeSuperCodexCatalog(binary: string, cwd: string, env: NodeJS.ProcessEnv, selection: SuperModelSelection = codexCoordinatorSelection): Promise<string> {
  const id = selection.model ?? codexCoordinatorSelection.model
  const model = (await listSuperCodexModels(binary, cwd, env)).find(entry => entry.slug === id)
  if (!model || (selection.reasoningEffort && !model.supported_reasoning_levels.some(level => level.effort === selection.reasoningEffort))) {
    throw new Error("This Codex model or reasoning effort is unavailable in the installed coordinator CLI")
  }
  const catalog = join(cwd, "catalog.json")
  await writeFile(catalog, JSON.stringify({ models: [{ ...model, tool_mode: null, multi_agent_version: null, experimental_supported_tools: [],
    supports_search_tool: false, apply_patch_tool_type: null, base_instructions: "", model_messages: null, node_repl_disabled: true,
    include_skills_usage_instructions:false, include_plugin_usage_instructions:false, include_apps_usage_instructions:false }] }))
  return catalog
}
const schemaText = JSON.stringify(strictSchema(superDecisionSchema as Schema))

/** Never send a saved ChatGPT session to an API endpoint selected by a provider override. */
export async function registeredCodexAuth(cwd: string, env: NodeJS.ProcessEnv, settings?: NodeJS.ProcessEnv): Promise<string[]> {
  if (!settings) return []
  // Ambient OPENAI_API_KEY can belong to another application. Normal CLI sign-in remains
  // authoritative unless this record supplies a key or an explicit API endpoint is in use.
  const endpoint = settings.OPENAI_BASE_URL
  const key = settings.CODEX_API_KEY || settings.OPENAI_API_KEY
  if (endpoint && !key) throw new Error("The configured Codex API endpoint requires its own API key.")
  if (!key) return []
  let apiArgs: string[] = []
  if (endpoint) {
    let url: URL
    try { url = new URL(endpoint) } catch { throw new Error("The configured Codex API endpoint is invalid.") }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("The configured Codex API endpoint is invalid.")
    apiArgs = ["-c", `openai_base_url=${JSON.stringify(endpoint)}`]
  }
  env.CODEX_HOME = await mkdtemp(join(cwd, "auth-"))
  // This verified CLI uses auth.json for API-key sessions. The private temporary home
  // also prevents reading or replacing the user's existing account login.
  await writeFile(join(env.CODEX_HOME, "auth.json"), JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 })
  // The ACP bridge launches app-server itself. Bind that process to the identical endpoint and private credential file.
  const config = (endpoint ? `openai_base_url = ${JSON.stringify(endpoint)}\n` : "") + 'cli_auth_credentials_store = "file"\n'
  await writeFile(join(env.CODEX_HOME, "config.toml"), config, { mode: 0o600 })
  return apiArgs
}

function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // Inherit the CLI's login location and network transport. Desktop tool pipes, callbacks, private prompt overrides
  // and third-party credentials are outside this non-interactive coordinator.
  for (const key of ["PATH","HOME","USERPROFILE","HOMEDRIVE","HOMEPATH","SystemRoot","LOCALAPPDATA","APPDATA","LANG","LC_ALL",
    "TMPDIR","TMP","TEMP","CODEX_HOME","HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","NO_PROXY","https_proxy","http_proxy",
    "all_proxy","no_proxy","SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS"]) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return env
}

function codexError(error: Error & { killed?: boolean; stderr?: string; stdout?: string }) {
  if (error.killed) return new Error("Codex timed out contacting the model service. Check its connection and retry this message.")
  const output = [error.stdout, error.stderr].join("\n")
  if (/\b(?:401|403)\b|not logged in|unauthorized|not authenticated|login required|authentication/i.test(output)) return new Error("Codex sign-in or access is required")
  if (/\b429\b|rate.?limit|quota|usage.?limit/i.test(output)) return new Error("Codex model quota is unavailable")
  if (/\b(?:502|503|504)\b|network|unreachable|connection|timed? ?out/i.test(output)) return new Error("The Codex model service is unreachable or temporarily unavailable. Check its connection and retry this message.")
  return new Error("Codex could not complete the routing request. Check that the signed-in account can use the configured coordinator model.")
}

export async function superCodexImageArgs(images: SuperImage[], cwd: string): Promise<string[]> {
  const args: string[] = []
  for (const [index, image] of images.entries()) {
    const extension: Record<string, string> = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/gif": "gif" }
    const suffix = extension[image.mimeType]
    if (!suffix) throw new Error("Unsupported coordinator image format")
    const file = join(cwd, `attachment-${index}.${suffix}`)
    await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 })
    args.push("--image", file)
  }
  return args
}

export const runCodexSuperDecisionModel: SuperDecisionModel = async (packet, signal, images = [], options = {}) => {
  if (process.platform !== "darwin") throw new Error("Codex coordination currently requires the verified macOS sandbox. Choose another configured coordinator on this platform.")
  const binary = await superModelBinary("codex", options.launch)
  const cwd = await mkdtemp(join(tmpdir(), "deskfleet-super-codex-"))
  try {
    const opts = { cwd, env: codexEnvironment(options.launch?.env), encoding: "utf8" as const, signal, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" as const }
    const version = (await exec(binary, ["--version"], { ...opts, timeout: 5000 })).stdout.trim()
    if (!supportsCodexCoordinatorVersion(version)) throw new Error(`Codex coordination requires a verified CLI version (${verifiedVersions.join(", ")}). Choose another configured coordinator or use a verified Codex version.`)
    const schema = join(cwd, "decision-schema.json"), instructions = join(cwd, "instructions.txt"), result = join(cwd, "decision.json")
    await Promise.all([writeFile(schema, schemaText), writeFile(instructions, superDecisionInstructions)])
    const selection = options.selection ?? codexCoordinatorSelection
    const catalog = await writeSuperCodexCatalog(binary, cwd, opts.env, selection)
    const authArgs = await registeredCodexAuth(cwd, opts.env, options.launch?.authEnv)
    const args = superCodexArgs(schema, instructions, result, catalog, selection)
    args.splice(args.indexOf("--output-schema"), 0, ...authArgs)
    args.splice(args.indexOf("--output-schema"), 0, ...await superCodexImageArgs(images, cwd))
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(sandbox, superCodexSandboxArgs(binary, args), opts, (error, stdout, stderr) => {
        if (error) { reject(codexError(Object.assign(error, { stdout, stderr }))); return }
        resolve(stdout)
      })
      child.stdin?.on("error", () => { /* handled on exit */ })
      child.stdin?.end(JSON.stringify(packet))
    })
    if (options.onUsage) {
      const { models } = JSON.parse(await readFile(catalog, "utf8")) as { models: unknown[] }
      options.onUsage(codexSuperUsage(stdout, models[0]))
    }
    const json = await readFile(result, "utf8")
    return JSON.parse(json, (_key, value: unknown) => value === null ? undefined : value)
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
