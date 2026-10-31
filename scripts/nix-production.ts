import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

// These values already ship in the renderer. Signing credentials and other
// environment variables must never become inputs to a public Nix derivation.
export const publicVariables = [
  "VITE_DESKFLEET_SERVER_URL",
  "VITE_STATSIG_CLIENT_KEY",
  "VITE_STATSIG_ENVIRONMENT",
  "VITE_SENTRY_DSN",
  "VITE_SENTRY_ENVIRONMENT",
] as const

type PublicVariable = typeof publicVariables[number]
type ProductionConfiguration = Record<PublicVariable, string>

export function productionConfiguration(variables: Record<string, string | undefined>): ProductionConfiguration {
  const configuration = Object.fromEntries(publicVariables.map(name => [name, variables[name]?.trim() ?? ""])) as ProductionConfiguration
  if (!configuration.VITE_DESKFLEET_SERVER_URL) {
    throw new Error("Set VITE_DESKFLEET_SERVER_URL in the production environment before synchronizing or publishing Nix packages.")
  }
  return configuration
}

export function checkProductionConfiguration(filename: string, variables: Record<string, string | undefined>): void {
  const expected = productionConfiguration(variables)
  const actual: unknown = JSON.parse(readFileSync(filename, "utf8"))
  if (!actual || typeof actual !== "object" || Array.isArray(actual)
    || Object.keys(actual).length !== publicVariables.length
    || publicVariables.some(name => typeof (actual as Record<string, unknown>)[name] !== "string")) {
    throw new Error("The Nix production snapshot must contain exactly the five public renderer variables.")
  }
  const changed = publicVariables.filter(name => (actual as ProductionConfiguration)[name] !== expected[name])
  if (changed.length) {
    throw new Error(`Nix production configuration differs for ${changed.join(", ")}. Run mise exec node -- node scripts/nix-production.ts sync and commit the snapshot before tagging a release.`)
  }
}

function synchronize(filename: string): void {
  const response = execFileSync("gh", [
    "api", "repos/yet-another-ai/deskfleet/environments/production/variables", "--paginate", "--slurp",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  const pages = JSON.parse(response) as { variables: { name: string; value: string }[] }[]
  const variables = Object.fromEntries(pages.flatMap(page => page.variables
    .filter(variable => publicVariables.includes(variable.name as PublicVariable))
    .map(variable => [variable.name, variable.value])))
  const configuration = productionConfiguration(variables)
  mkdirSync(dirname(filename), { recursive: true })
  writeFileSync(filename, JSON.stringify(configuration, null, 2) + "\n")
}

if (import.meta.main) {
  const [command, filename = fileURLToPath(new URL("../nix/production.json", import.meta.url)), ...extra] = process.argv.slice(2)
  if (extra.length || (command !== "sync" && command !== "check")) {
    throw new Error("Usage: node scripts/nix-production.ts <sync|check> [snapshot.json]")
  }
  if (command === "sync") synchronize(filename)
  else checkProductionConfiguration(filename, process.env)
  console.log(command === "sync" ? "Synchronized public Nix production configuration." : "Nix production configuration matches the production environment.")
}
