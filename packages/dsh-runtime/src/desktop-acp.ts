import { join } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { readDesktopRoutes, type DesktopRoutes } from "./desktop-routes.ts"

interface LaunchEnvironment {
  getFrom(name: string, sources: readonly string[]): unknown
}
interface PluginContext {
  llm: { registerAdapter(providers: string[], adapter: unknown): unknown }
  launchEnvironment: LaunchEnvironment
  get(name: string): unknown
  effect(fn: () => () => Promise<void>): void
  provide(name: string, value: unknown): void
  plugin(module: unknown, config?: unknown): PromiseLike<unknown>
}
interface BridgeConfig { entryPoint: string; home: string; ids: string[] }
const ready = "deskfleetDesktopModels"

/** ACP loads this plugin alongside its existing providers. Only the adapter is
 * shared; desktop credential reads and OAuth refreshes use the desktop store. */
export async function apply(ctx: PluginContext, config: BridgeConfig) {
  const { providers } = await readDesktopRoutes(config.entryPoint, { DSH_HOME: config.home, DESKFLEET_DSH_DESKTOP_ROUTES: "1" })
  const selected = Object.fromEntries(config.ids.filter(id => Object.hasOwn(providers, id)).map(id => [id, providers[id]]))
  const base = createRequire(createRequire(config.entryPoint).resolve("@deepseek-ai/dsh-base/package.json"))
  const load = (name: string) => import(pathToFileURL(base.resolve(name)).href)
  const [{ Context }, { LocalCredentialProvider }, { LlmRuntime }, pi] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-credentials-local"),
    load("@deepseek-ai/dsh-llm"), load("@deepseek-ai/dsh-llm-pi-ai"),
  ])
  const local = new Context()
  ctx.effect(() => () => local.fiber.dispose())
  for (const name of ["attachments", "fs"]) {
    const service = ctx.get(name)
    if (service) local.provide(name, service)
  }
  // Preserve the original snapshot's provenance. Loading .env again would
  // relabel values from this Worker project's .env as inherited credentials.
  const getFrom = (key: string, sources: readonly string[]) => ctx.launchEnvironment.getFrom(key, sources.filter(source => source !== "project-env"))
  local.provide("launchEnvironment", { get: (key: string) => getFrom(key, ["process", "user-env"]), getFrom })
  await local.plugin(LocalCredentialProvider, { dshHome: config.home, watch: false })
  // pi-ai owns a complete discovery/settings catalog, even for zero routes.
  // Keep its second catalog private while mounting the actual adapter in ACP.
  class DesktopModels extends LlmRuntime {
    registerAdapter(ids: string[], adapter: unknown) { return ctx.llm.registerAdapter(ids, adapter) }
  }
  await local.plugin(DesktopModels)
  await local.plugin(pi, { providers: selected })
  ctx.provide(ready, true)
}

interface ProfileRow { id: string; config?: Record<string, unknown>; inject?: string[] | Record<string, unknown> }

/** Keep the user's ACP profile and the registration's account patch. The generated
 * entries live in the startup composition; no credentials or custom headers are
 * written to a temporary patch or forwarded to the client. */
export async function runDesktopAcp(entryPoint: string, environment: unknown, patchFiles: string[], routes: DesktopRoutes) {
  const runtime = createRequire(entryPoint)
  const load = (name: string) => import(pathToFileURL(runtime.resolve(name)).href)
  const { runProfile, prepareProfile, INSTALL_ANCHOR } = await load("@deepseek-ai/dsh/profile-boot")
  const launch = { environment, profile: "acp", patchFiles, args: [] }
  if (!Object.keys(routes.providers).length) return runProfile(launch)
  const { composeEntries, loadOptionalPatches } = await load("@deepseek-ai/dsh-app-boot")
  const profile = prepareProfile("acp")
  const homePatches = loadOptionalPatches("dsh", join(routes.home, "cordis.patch.yml")) ?? []
  const entries: ProfileRow[] = composeEntries([...profile.layers.map((layer: { patches: unknown[] }) => layer.patches), profile.patches, homePatches])
  const acp = entries.find(row => row.id === "acp")
  const ownProviders = entries.find(row => row.id === "llm-pi-ai")?.config?.providers
  const ids = Object.keys(routes.providers).filter(id => !ownProviders || !Object.hasOwn(ownProviders, id))
  if (!acp || !ids.length) return runProfile(launch)
  const preferred = routes.preferred && ids.includes(routes.preferred.provider) ? routes.preferred : undefined
  const inject = Array.isArray(acp.inject) ? [...acp.inject, ready] : { ...acp.inject, [ready]: true }
  profile.patches.push(
    { insert: [{ id: "deskfleet-desktop-models", name: import.meta.url, inject: ["llm", "launchEnvironment"], config: { entryPoint, home: routes.home, ids } }] },
    { id: "acp", inject, ...(preferred && { config: preferred }) },
  )
  return runProfile({ ...launch, patchFiles: preferred ? patchFiles.filter(file => !file.endsWith("account-acp.yml")) : patchFiles,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR } })
}
