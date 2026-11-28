import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { join } from "node:path"

type Settings = Record<string, unknown>
export interface DesktopRoutes {
  home: string
  providers: Record<string, Settings>
  preferred?: { provider: string; model: string }
}

const modelsPlugin = "llm-pi-ai"
const preferencePlugin = "agent-default-model"
const isObject = (value: unknown): value is Settings => typeof value === "object" && value !== null && !Array.isArray(value)

// Boot parses !!js tags into inert __jsExpr objects. Only declarative route settings
// can cross into an ACP overlay, where the normal profile loader evaluates those tags.
function declarative(value: unknown, ancestors = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return true
  if (ancestors.has(value)) return false
  ancestors.add(value)
  const safe = Object.entries(value).every(([key, item]) =>
    !["__jsExpr", "__proto__", "constructor", "prototype"].includes(key) && declarative(item, ancestors))
  ancestors.delete(value)
  return safe
}

/** Import the two settings rows written by the Harness desktop Models UI using its
 * own loader and patch semantics. No desktop bundles, plugins or expressions run. */
export async function readDesktopRoutes(entryPoint: string, env: NodeJS.ProcessEnv = process.env): Promise<DesktopRoutes> {
  if (env.DESKFLEET_DSH_DESKTOP_ROUTES !== "1" && (env.DESKFLEET_DSH_DESKTOP_ROUTES !== undefined || !env.DSH_HOME?.trim())) {
    return { home: "", providers: {} }
  }
  const runtime = createRequire(entryPoint)
  const { resolveDshHome } = await import(pathToFileURL(runtime.resolve("@deepseek-ai/dsh-home-paths")).href)
  const { composeEntries, loadOptionalPatches, resolveProfileDir, PROFILE_PATCH_FILENAME } =
    await import(pathToFileURL(runtime.resolve("@deepseek-ai/dsh-app-boot")).href)
  const home: string = resolveDshHome(undefined, env)
  const result: DesktopRoutes = { home, providers: {} }
  try {
    // Follow readProfilePatches ordering: machine-wide settings override the desktop profile.
    const patches: Settings[] = [resolveProfileDir("desktop", home), home]
      .flatMap(directory => loadOptionalPatches("dsh", join(directory, PROFILE_PATCH_FILENAME)) ?? [])
    const rows: { id: string; config?: Settings; disabled?: boolean }[] = composeEntries([
      [{ insert: [modelsPlugin, preferencePlugin].map(id => ({ id, name: `@deepseek-ai/dsh-${id}` })) }],
      patches.filter(row => !row.insert && (row.id === modelsPlugin || row.id === preferencePlugin)),
    ])
    const configs = new Map(rows.filter(row => !row.disabled).map(row => [row.id, row.config]))
    const providers = configs.get(modelsPlugin)?.providers
    if (isObject(providers)) {
      result.providers = Object.fromEntries(Object.entries(providers).filter(([id, route]) =>
        !["deepseek-official", "deepseek-account", "__proto__", "constructor", "prototype", "__jsExpr"].includes(id) &&
        isObject(route) && declarative(route))) as DesktopRoutes["providers"]
    }
    const preferred = configs.get(preferencePlugin)
    if (typeof preferred?.provider === "string" && typeof preferred.model === "string" && Object.hasOwn(result.providers, preferred.provider)) {
      result.preferred = { provider: preferred.provider, model: preferred.model }
    }
  } catch {
    // YAML errors can contain raw headers or credentials from a source line.
    // The registration's own DeepSeek routes remain usable if desktop data is invalid.
    process.stderr.write("DSH desktop model settings could not be read. Check the desktop Models configuration.\n")
  }
  return result
}
