import { delimiter } from "node:path"

/** Windows treats PATH names case-insensitively; the last override wins. */
export function commandPath(env: NodeJS.ProcessEnv): string | undefined {
  return Object.entries(env).findLast(([name]) => process.platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH")?.[1]
}

/** Add bundled commands to one child environment without changing host or saved settings. */
export function commandEnvironment(
  env: Record<string, string>,
  directory?: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!directory) return { ...env }
  const path = commandPath(env) ?? commandPath(inherited)
  const entries = path === undefined || path === "" ? [] : path.split(delimiter)
  const same = (value: string) => process.platform === "win32" ? value.toLowerCase() === directory.toLowerCase() : value === directory
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => process.platform === "win32" ? name.toUpperCase() !== "PATH" : name !== "PATH")),
    PATH: [directory, ...entries.filter(value => !same(value))].join(delimiter),
  }
}
