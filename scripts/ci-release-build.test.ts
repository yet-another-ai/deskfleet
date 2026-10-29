import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test, { type TestContext } from "node:test"

function releaseBuild(context: TestContext) {
  const yaml = readFileSync(join(import.meta.dirname, "../.github/workflows/build.yml"), "utf8").replace(/\r\n/g, "\n")
  const names = [
    "Validate production release configuration",
    "Build production server, daemon, and Web bundles",
    "Build production Electron bundles",
  ]
  const steps = yaml.split(/^      - name: /m).slice(1).flatMap(block => {
    const name = block.split("\n", 1)[0]!
    if (!names.includes(name)) return []
    const command = block.match(/^        run: (.+)$/m)?.[1]
    assert.ok(command, `Missing command for ${name}`)
    const script = command === "|"
      ? block.match(/^        run: \|\n((?:          .*\n)+)/m)?.[1]?.replace(/^ {10}/gm, "")
      : command
    assert.ok(script, `Missing script for ${name}`)
    const shell = block.match(/^        shell: (.+)$/m)?.[1]
    if (name.startsWith("Build ")) assert.equal(shell, undefined, "Native builds must retain the runner's default shell, including pwsh on Windows")
    const variables = [...block.matchAll(/^          (\w+): \$\{\{ vars\.(\w+) \}\}$/gm)]
      .map(match => [match[1]!, match[2]!] as const)
    return [{ name, script, shell, variables }]
  })
  assert.deepEqual(steps.map(step => step.name), names)
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-release-build-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const log = join(directory, "calls")
  const fixture = join(directory, "mise.mjs")
  writeFileSync(fixture, `import { appendFileSync } from "node:fs"
appendFileSync(process.env.DESKFLEET_BUILD_LOG, JSON.stringify([
  process.argv.slice(2).join(" "),
  ...["VITE_DESKFLEET_SERVER_URL", "VITE_STATSIG_CLIENT_KEY", "VITE_STATSIG_ENVIRONMENT"].map(name => process.env[name] ?? "<unset>"),
]) + "\\n")
`)
  if (process.platform === "win32") writeFileSync(join(directory, "mise.cmd"), '@"%DESKFLEET_TEST_NODE%" "%DESKFLEET_MISE_FIXTURE%" %*\r\n')
  else writeFileSync(join(directory, "mise"), `#!/bin/sh
exec "$DESKFLEET_TEST_NODE" "$DESKFLEET_MISE_FIXTURE" "$@"
`, { mode: 0o755 })
  const excluded = new Set(["PATH", "DESKTOP_SERVER_URL", "VITE_DESKFLEET_SERVER_URL", "VITE_STATSIG_CLIENT_KEY", "VITE_STATSIG_ENVIRONMENT"])
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.has(name.toUpperCase())))
  const path = Object.entries(process.env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? ""
  return {
    run: (variables: NodeJS.ProcessEnv) => {
      for (const [index, step] of steps.entries()) {
        const shell = step.shell ?? (process.platform === "win32" ? "pwsh" : "bash")
        const args = shell === "pwsh"
          ? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'\n${step.script}\nexit $LASTEXITCODE`]
          : ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.script]
        // Match Actions' shell:bash, which uses Git Bash rather than WSL on Windows.
        const executable = shell === "bash" && process.platform === "win32"
          ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
          : shell
        const result = spawnSync(executable, args, {
          encoding: "utf8",
          env: {
            ...env, PATH: `${directory}${delimiter}${path}`, DESKFLEET_BUILD_LOG: log,
            DESKFLEET_TEST_NODE: process.execPath, DESKFLEET_MISE_FIXTURE: fixture,
            ...Object.fromEntries(step.variables.map(([name, variable]) => [name, variables[variable] ?? ""])),
          },
        })
        assert.ifError(result.error)
        if (result.status !== 0 || index === steps.length - 1) return result
      }
      throw new Error("No production build steps ran")
    },
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").flatMap(line => JSON.parse(line) as string[]) : [],
  }
}

test("release build keeps Web same-origin and embeds the API origin only in Electron", context => {
  const build = releaseBuild(context)
  const result = build.run({
    VITE_DESKFLEET_SERVER_URL: "https://api.example.com",
    VITE_STATSIG_CLIENT_KEY: "client-fixture",
    VITE_STATSIG_ENVIRONMENT: "production",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(build.calls(), [
    "run build", "<unset>", "client-fixture", "production",
    "exec -- pnpm --filter @deskfleet/desktop build", "https://api.example.com", "client-fixture", "production",
  ])
})

test("release build rejects an unset or empty API origin before building artifacts", context => {
  const build = releaseBuild(context)
  for (const origin of [undefined, ""]) {
    const result = build.run({ VITE_DESKFLEET_SERVER_URL: origin })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /::error::Set VITE_DESKFLEET_SERVER_URL in the production environment/)
    assert.deepEqual(build.calls(), [])
  }
})
