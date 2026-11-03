import { join } from "node:path"

/** The staged native executable stays outside ASAR on every platform. */
export function resolveAuvPath(options: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  const executable = process.platform === "win32" ? "auv.exe" : "auv"
  if (!options.isPackaged) return join(options.appPath, "out", "auv", executable)
  if (process.platform === "darwin") return join(options.resourcesPath, "..", "MacOS", executable)
  return join(options.resourcesPath, "bin", executable)
}
