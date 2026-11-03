import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { parseSentryDsn } from "../packages/client/src/sentry-config.ts"

type Run = (args: string[], env: NodeJS.ProcessEnv) => void

/** Release artifacts match the renderer URLs and the main stack's app:/// basenames. */
export function uploadSourceMaps(root: string, platform: string, env: NodeJS.ProcessEnv, run?: Run): void {
  if (!["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"].includes(platform)) throw new Error("Unknown source-map distribution")
  const groups = [
    { directory: "apps/web/dist", prefix: "~/", dist: "web" },
    { directory: "apps/desktop/out/main", prefix: "app:///", dist: platform },
    { directory: "apps/desktop/out/renderer", prefix: "deskfleet-app://bundle/", dist: platform },
  ].map(group => {
    const directory = resolve(root, group.directory)
    const maps = existsSync(directory) ? readdirSync(directory, { recursive: true }).filter(name => typeof name === "string" && name.endsWith(".js.map")) as string[] : []
    return { ...group, directory, maps }
  })
  const execute: Run = run ?? ((args, cliEnv) => {
    const result = spawnSync(process.execPath, [resolve(root, "node_modules/@sentry/cli/bin/sentry-cli"), ...args], { env: cliEnv, stdio: "inherit" })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error("Sentry source-map upload failed")
  })
  try {
    if (!parseSentryDsn(env.VITE_SENTRY_DSN)) return
    for (const key of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "VITE_SENTRY_RELEASE"]) {
      if (!env[key]?.trim()) throw new Error(`Source-map upload requires ${key}`)
    }
    for (const group of groups) {
      if (!group.maps.length) throw new Error(`No JavaScript source maps in ${group.directory}`)
      execute(["sourcemaps", "upload", "--release", env.VITE_SENTRY_RELEASE!.trim(), "--dist", group.dist,
        "--url-prefix", group.prefix, "--validate", "--strict", "--wait", group.directory],
      { ...env, SENTRY_URL: env.SENTRY_URL?.trim() || "https://sentry.io/" })
    }
  } finally {
    // Upload before packaging. Hidden maps must not enter the public Web artifact.
    for (const group of groups) for (const map of group.maps) rmSync(resolve(group.directory, map))
  }
}

if (import.meta.main) uploadSourceMaps(resolve(import.meta.dirname, ".."), process.argv[2] ?? "", process.env)
