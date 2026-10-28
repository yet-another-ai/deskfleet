import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

function releaseBuild(context: TestContext) {
  const yaml = readFileSync(join(import.meta.dirname, "../.github/workflows/build.yml"), "utf8")
  const block = yaml.match(/^      - name: Build production release bundles\n[\s\S]*?^        run: \|\n((?:          .*\n)+)/m)?.[1]
  assert.ok(block, "Missing production build shell step")
  const script = block.replace(/^ {10}/gm, "")
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-release-build-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const log = join(directory, "calls")
  writeFileSync(join(directory, "mise"), `#!/bin/sh
printf '%s\\n' "$*" "\${VITE_DESKFLEET_SERVER_URL-<unset>}" "\${VITE_STATSIG_CLIENT_KEY-<unset>}" "\${VITE_STATSIG_ENVIRONMENT-<unset>}" >> "$DESKFLEET_BUILD_LOG"
`, { mode: 0o755 })
  const env = { ...process.env }
  for (const name of ["DESKTOP_SERVER_URL", "VITE_DESKFLEET_SERVER_URL", "VITE_STATSIG_CLIENT_KEY", "VITE_STATSIG_ENVIRONMENT"])
    delete env[name]
  return {
    run: (overrides: NodeJS.ProcessEnv) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { ...env, PATH: `${directory}:${env.PATH}`, DESKFLEET_BUILD_LOG: log, ...overrides },
    }),
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [],
  }
}

test("release build keeps Web same-origin and embeds the API origin only in Electron", { skip: process.platform === "win32" }, context => {
  const build = releaseBuild(context)
  const result = build.run({
    DESKTOP_SERVER_URL: "https://api.example.com",
    VITE_STATSIG_CLIENT_KEY: "client-fixture",
    VITE_STATSIG_ENVIRONMENT: "production",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(build.calls(), [
    "run build", "<unset>", "client-fixture", "production",
    "exec -- pnpm --filter @deskfleet/desktop build", "https://api.example.com", "client-fixture", "production",
  ])
})

test("release build rejects an unset or empty API origin before building artifacts", { skip: process.platform === "win32" }, context => {
  const build = releaseBuild(context)
  for (const origin of [undefined, ""]) {
    const result = build.run({ DESKTOP_SERVER_URL: origin })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /::error::Set VITE_DESKFLEET_SERVER_URL in the production environment/)
    assert.deepEqual(build.calls(), [])
  }
})
