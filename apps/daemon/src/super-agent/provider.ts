import { execFile } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { dshCoordinatorProcess } from "@deskfleet/dsh-runtime"
import type { AgentProviders } from "../providers/providers.ts"
import { providerProcessEnv } from "../agent/usage.ts"
import { acpCoordinatorModel, acpCoordinatorOptions } from "./acp.ts"
import { registeredCodexAuth, runCodexSuperDecisionModel } from "./codex.ts"
import { runSuperDecisionModel, superDecisionInstructions, superDecisionSchema } from "./model.ts"
import { queryCliCoordinatorOptions } from "./profiles.ts"
import type { SuperCoordinatorOptions, SuperCoordinatorUsage } from "@deskfleet/protocol/super-agent"
import type { SuperDecisionModel } from "./router.ts"

const unavailable: SuperCoordinatorOptions = { models: [], defaultReasoningEfforts: [] }

const errors: Record<string, string> = {
  DSH_NO_MODELS: "DeepSeek Harness has no available models. Check this provider’s sign-in or API key.",
  DSH_AUTH: "DeepSeek Harness sign-in or an API key is required.",
  DSH_MODEL_UNAVAILABLE: "This DeepSeek Harness model is no longer available.",
  DSH_EFFORT_UNAVAILABLE: "The selected DeepSeek Harness model does not offer this reasoning effort.",
  DSH_IMAGE_UNSUPPORTED: "The selected DeepSeek Harness model does not support image input.",
  DSH_QUOTA: "DeepSeek Harness model quota is unavailable.",
}
async function queryDsh<T>(input: { action: "decide" | "options" } & Record<string, unknown>, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<T> {
  const launch = dshCoordinatorProcess(env)
  const cwd = await mkdtemp(join(tmpdir(), "deskfleet-super-dsh-"))
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = execFile(launch.command, launch.args ?? [], {
        env: launch.env, cwd, encoding: "utf8", timeout: input.action === "decide" ? 120_000 : 15_000,
        killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal,
      }, (error, stdout) => {
        // Upstream stderr/output can contain account information. Only the helper's known failures enter the timeline.
        if (!error) {
          try {
            const response = JSON.parse(stdout)
            if (Object.hasOwn(response, "result")) { resolve(response.result); return }
            if (Object.hasOwn(errors, response.error)) { reject(new Error(errors[response.error])); return }
          } catch { /* Report a bounded routing error below. */ }
        }
        reject(new Error("DeepSeek Harness could not complete the routing request. Check the provider configuration and connection."))
      })
      child.stdin?.on("error", () => { /* The exit handler reports early child exits. */ })
      child.stdin?.end(JSON.stringify(input))
    })
  } finally { await rm(cwd, { recursive: true, force: true }) }
}

interface Transport {
  options: (selected?: string) => Promise<SuperCoordinatorOptions>
  model: SuperDecisionModel
}

export function createCoordinatorRuntime(registry: AgentProviders) {
  type Entry = { expires: number; result: Promise<SuperCoordinatorOptions>; value?: SuperCoordinatorOptions }
  const cache = new Map<string, Entry>()
  const transports = new Map<string, { expires: number; result: Promise<Transport> }>()
  const stop = new AbortController()
  const pending = new Set<Promise<SuperCoordinatorOptions>>()
  let revision: string | undefined
  function refresh() {
    const current = registry.metadata().revision
    if (current !== revision) { cache.clear(); transports.clear(); revision = current }
  }
  function catalog(key: string, read: () => Promise<SuperCoordinatorOptions>): Entry {
    stop.signal.throwIfAborted()
    const previous = cache.get(key)
    if (previous && previous.expires > Date.now()) return previous
    // Model-specific probes can be requested concurrently by several clients.
    if (cache.size >= 128) cache.delete(cache.keys().next().value!)
    const entry: Entry = { expires: Date.now() + 300_000, result: read().catch(() => unavailable) }
    cache.set(key, entry)
    pending.add(entry.result)
    void entry.result.then(value => {
      entry.value = value
      if (!value.models.length) entry.expires = Date.now() + 30_000
      pending.delete(entry.result)
    })
    return entry
  }

  async function transport(id: string, signal?: AbortSignal): Promise<Transport> {
    const registrationRevision = registry.metadata().revision
    const record = registry.get(id)
    const instance = registry.resolve(id)
    const acp: typeof instance & { prepareConfig?: (cwd: string) => Promise<typeof instance.config> } = instance
    const cacheKey = (kind: string, model?: string) => JSON.stringify([registrationRevision, id, kind, model])
    const acpOptions = (model?: string) => catalog(cacheKey("acp", model), () => acpCoordinatorOptions(acp, model, stop.signal))
    const common = { options: (model?: string) => acpOptions(model).result, model: acpCoordinatorModel(acp) }

    if (record.template === "deepseek-harness" && !record.binaryPath) {
      // The bundled helper and ACP runtime already share the DSH model-route catalog.
      const config = await registry.coordinatorConfig(id, signal)
      const env = providerProcessEnv(config.env)
      return {
        options: () => catalog(cacheKey("dsh"), () => queryDsh<SuperCoordinatorOptions>({ action: "options" }, env, stop.signal)).result,
        model: async (packet, abort, images, settings) => {
          const response = await queryDsh<{ decision: unknown; usage?: SuperCoordinatorUsage }>({
            action: "decide", system: superDecisionInstructions + "\nReturn a single JSON object, without Markdown fences. Schema:\n" + JSON.stringify(superDecisionSchema),
            text: JSON.stringify(packet), ...settings?.selection, images,
          }, env, abort)
          settings?.onUsage?.(response.usage)
          return response.decision
        },
      }
    }
    if (record.template !== "codex" && record.template !== "claude-code") return common

    const config = await registry.coordinatorConfig(id, signal)
    if (config.binaryPath && isAbsolute(config.binaryPath)) await access(config.binaryPath)
    const env = providerProcessEnv(config.env)
    const authEnv = {
      OPENAI_BASE_URL: env.OPENAI_BASE_URL,
      CODEX_API_KEY: record.env.CODEX_API_KEY ?? (env.OPENAI_BASE_URL ? env.CODEX_API_KEY : undefined),
      OPENAI_API_KEY: record.env.OPENAI_API_KEY ?? (env.OPENAI_BASE_URL ? env.OPENAI_API_KEY : undefined),
    }
    const codex = record.template === "codex"
    if (codex && (authEnv.OPENAI_BASE_URL || authEnv.CODEX_API_KEY || authEnv.OPENAI_API_KEY)) {
      acp.prepareConfig = async cwd => {
        const scoped = { ...config.env }
        await registeredCodexAuth(cwd, scoped, authEnv)
        return { ...config, env: scoped }
      }
    }
    if (codex && process.platform !== "darwin") return common
    const launch = { binaryPath: config.binaryPath, env, authEnv }
    const native = codex ? runCodexSuperDecisionModel : runSuperDecisionModel
    const nativeOptions = () => catalog(cacheKey("native"), () => queryCliCoordinatorOptions(record.template, launch)).result
    return {
      async options(model) {
        const shared = acpOptions(model)
        const optimized = await nativeOptions()
        // Existing clients poll snapshots. Return a usable catalog immediately while the full registration warms.
        if (!shared.value && optimized.models.length && (!model || optimized.models.some(item => item.id === model))) return optimized
        const registered = shared.value ?? await shared.result
        if (!registered.models.length) return optimized
        const defaultModel = optimized.defaultModel && registered.models.some(m => m.id === optimized.defaultModel)
          ? optimized.defaultModel : registered.defaultModel
        const models = registered.models.map(m => {
          const known = optimized.models.find(n => n.id === m.id)
          return known ? { ...known, reasoningEfforts: [...new Set([...m.reasoningEfforts, ...known.reasoningEfforts])],
            defaultReasoningEffort: m.defaultReasoningEffort ?? known.defaultReasoningEffort } : m
        })
        return { models, defaultModel, defaultReasoningEfforts: models.find(m => m.id === defaultModel)?.reasoningEfforts ?? registered.defaultReasoningEfforts }
      },
      async model(packet, abort, images, settings) {
        const optimized = await nativeOptions()
        const { model: selected, reasoningEffort } = settings?.selection ?? {}
        const nativeModel = optimized.models.find(item => item.id === (selected ?? optimized.defaultModel))
        const supportsModel = nativeModel || (!selected && !codex && optimized.models.length > 0)
        const supportsEffort = !reasoningEffort || (nativeModel?.reasoningEfforts ?? optimized.defaultReasoningEfforts).includes(reasoningEffort)
        // Choose the transport before sending a prompt. Inference errors never replay on another transport.
        if (supportsModel && supportsEffort) return native(packet, abort, images, { ...settings, launch })
        return common.model(packet, abort, images, settings)
      },
    }
  }
  return {
    async options(id: string, selected?: string) {
      refresh()
      let entry = transports.get(id)
      if (!entry || entry.expires <= Date.now()) {
        try { registry.get(id) } catch { return unavailable }
        entry = { expires: Date.now() + 300_000, result: transport(id, stop.signal) }
        transports.set(id, entry)
      }
      try { return await (await entry.result).options(selected) }
      catch { if (transports.get(id) === entry) transports.delete(id); return unavailable }
    },
    model(id: string): SuperDecisionModel {
      return async (packet, signal, images, options) => {
        signal?.throwIfAborted()
        refresh()
        return (await transport(id, signal)).model(packet, signal, images, options)
      }
    },
    async close() {
      stop.abort()
      await Promise.allSettled(pending)
    },
  }
}
