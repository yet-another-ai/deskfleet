import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dshCoordinatorProcess } from "@deskfleet/dsh-runtime"
import type { AgentProviders } from "./agent-providers.ts"
import { providerProcessEnv } from "./agent-usage.ts"
import { runCodexSuperDecisionModel } from "./super-agent-codex.ts"
import { runSuperDecisionModel, superDecisionInstructions, superDecisionSchema } from "./super-agent-model.ts"
import { queryCliCoordinatorOptions } from "./super-agent-profiles.ts"
import type { SuperCoordinatorOptions, SuperCoordinatorUsage } from "./super-agent-protocol.ts"
import type { SuperDecisionModel } from "./super-agent-router.ts"

const unavailable: SuperCoordinatorOptions = { models: [], defaultReasoningEfforts: [] }

export function supportsCoordinator(record: { template: string; binaryPath?: string }) {
  return record.template === "claude-code" || (record.template === "codex" && process.platform === "darwin")
    || (record.template === "deepseek-harness" && !record.binaryPath)
}

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

export function createCoordinatorRuntime(registry: AgentProviders) {
  const cache = new Map<string, { expires: number; result: Promise<SuperCoordinatorOptions> }>()
  let revision: string | undefined
  function supports(id: string) {
    try { return supportsCoordinator(registry.get(id)) } catch { return false }
  }
  async function launch(id: string, signal?: AbortSignal) {
    const record = registry.get(id)
    if (!supportsCoordinator(record)) throw new Error("This provider does not have a read-only coordinator adapter")
    const config = await registry.coordinatorConfig(id, signal)
    const env = providerProcessEnv(config.env)
    // An inherited custom endpoint is also explicit routing. Pair it only with API-key
    // authentication from the same resolved instance, never a fallback ChatGPT login.
    const authEnv = {
      OPENAI_BASE_URL: env.OPENAI_BASE_URL,
      CODEX_API_KEY: record.env.CODEX_API_KEY ?? (env.OPENAI_BASE_URL ? env.CODEX_API_KEY : undefined),
      OPENAI_API_KEY: record.env.OPENAI_API_KEY ?? (env.OPENAI_BASE_URL ? env.OPENAI_API_KEY : undefined),
    }
    return { template: record.template, binaryPath: config.binaryPath, env, authEnv }
  }
  function model(id: string): SuperDecisionModel {
    return async (packet, signal, images, options) => {
      const instance = await launch(id, signal)
      if (instance.template === "deepseek-harness") {
        const response = await queryDsh<{ decision: unknown; usage?: SuperCoordinatorUsage }>({
          action: "decide", system: superDecisionInstructions + "\nReturn a single JSON object, without Markdown fences. Schema:\n" + JSON.stringify(superDecisionSchema),
          text: JSON.stringify(packet), ...options?.selection, images,
        }, instance.env, signal)
        options?.onUsage?.(response.usage)
        return response.decision
      }
      const call = instance.template === "codex" ? runCodexSuperDecisionModel : runSuperDecisionModel
      return call(packet, signal, images, { ...options, launch: instance })
    }
  }
  function options(id: string) {
    const current = registry.metadata().revision
    if (current !== revision) { cache.clear(); revision = current }
    const previous = cache.get(id)
    if (previous && previous.expires > Date.now()) return previous.result
    const result = launch(id).then(instance => instance.template === "deepseek-harness"
      ? queryDsh<SuperCoordinatorOptions>({ action: "options" }, instance.env)
      : queryCliCoordinatorOptions(instance.template, instance)).catch(() => unavailable)
    const entry = { result, expires: Date.now() + 5 * 60_000 }
    cache.set(id, entry)
    void result.then(value => { if (!value.models.length) entry.expires = Date.now() + 30_000 })
    return result
  }
  return { supports, options, model }
}
