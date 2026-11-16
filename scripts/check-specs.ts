import { readFileSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"

/** Quint models in `specs/`, in a stable order. Other files in that directory are ignored. */
export function quintFiles(names: readonly string[]): string[] {
  return names.filter(name => name.endsWith(".qnt")).sort()
}

/** Names of `run` definitions. Quint's default test filter only selects names ending in `Test`. */
export function runNames(source: string): string[] {
  return [...source.matchAll(/^\s*run\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gmu)].map(match => match[1] ?? "")
}

function run(args: string[]): number {
  const result = spawnSync("quint", args, { stdio: "inherit" })
  return result.status ?? 1
}

if (import.meta.main) {
  const files = quintFiles(readdirSync("specs"))
  if (files.length === 0) {
    console.error("specs/ contains no Quint model")
    process.exit(1)
  }
  let status = 0
  for (const name of files) {
    const file = `specs/${name}`
    const names = runNames(readFileSync(file, "utf8"))
    if (names.length === 0) {
      console.error(`${file} contains no run`)
      process.exit(1)
    }
    status = run(["typecheck", file])
    if (status !== 0) process.exit(status)
    status = run(["test", file, "--max-samples", "200", "--seed", "1", "--match", `^(?:${names.join("|")})$`])
    if (status !== 0) process.exit(status)
  }
}
