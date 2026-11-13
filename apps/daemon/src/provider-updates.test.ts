import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { AgentProviders } from "./agent-providers.ts"
import type { ProbeCommand, ProbeCommandResult } from "./provider-setup-process.ts"
import {
  extractProviderVersion,
  fetchLatestProviderVersion,
  isProviderVersionNewer,
  ProviderUpdates,
} from "./provider-updates.ts"

const ok = (stdout: string): ProbeCommandResult => ({ stdout, stderr: "", code: 0 })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("extracts and compares SemVer, prerelease, and Cursor date-hash versions", () => {
  assert.equal(extractProviderVersion("codex", "codex-cli 0.167.2"), "0.167.2")
  assert.equal(extractProviderVersion("codex", "rust-v0.167.2"), "0.167.2")
  assert.equal(extractProviderVersion("claude-code", "\x1b[32m2.1.200 (Claude Code)\x1b[0m"), "2.1.200")
  assert.equal(extractProviderVersion("cursor", "cursor-agent 2026.11.11-b912975"), "2026.11.11-b912975")

  assert.equal(isProviderVersionNewer("codex", "0.166.9", "0.167.0"), true)
  assert.equal(isProviderVersionNewer("codex", "0.167.0", "0.167.0"), false)
  assert.equal(isProviderVersionNewer("codex", "0.167.2", "0.167.1"), false)
  assert.equal(isProviderVersionNewer("codex", "1.2.0-rc.1", "1.2.0"), true)
  assert.equal(isProviderVersionNewer("codex", "1.2.0", "1.2.0-rc.1"), false)
  assert.equal(isProviderVersionNewer("codex", "1.2.0-alpha.2", "1.2.0-alpha.10"), true)

  assert.equal(isProviderVersionNewer("cursor", "2026.11.09-aaaaaaa", "2026.11.11-bbbbbbb"), true)
  assert.equal(isProviderVersionNewer("cursor", "2026.11.11-aaaaaaa", "2026.11.11-bbbbbbb"), true)
  assert.equal(isProviderVersionNewer("cursor", "2026.11.11-bbbbbbb", "2026.11.11-bbbbbbb"), false)
  assert.equal(isProviderVersionNewer("cursor", "2026.11.12-aaaaaaa", "2026.11.11-bbbbbbb"), false)
})

test("reads upstream release versions and rejects failed responses", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === "https://releases.openai.com/codex/channels/latest") return Response.json({ tag_name: "rust-v0.167.2" })
    if (url === "https://cursor.com/install") return new Response("DOWNLOAD_URL=\"https://downloads.cursor.com/lab/2026.11.11-b912975/darwin/arm64/agent.tar.gz\"")
    if (url === "https://cursor.com/install?win32=true") return new Response("$version = '2026.11.12-c0ffee1'")
    return new Response("unavailable", { status: 503 })
  }) as typeof fetch

  assert.equal(await fetchLatestProviderVersion("codex", { platform: "linux", arch: "x64", fetchImpl }), "0.167.2")
  assert.equal(await fetchLatestProviderVersion("cursor", { platform: "darwin", arch: "arm64", fetchImpl }), "2026.11.11-b912975")
  assert.equal(await fetchLatestProviderVersion("cursor", { platform: "win32", arch: "x64", fetchImpl }), "2026.11.12-c0ffee1")
  await assert.rejects(fetchLatestProviderVersion("grok", { platform: "linux", arch: "x64", fetchImpl }), /HTTP 503/u)
})

test("tracks one update per CLI template from its oldest installed executable", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-updates-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const providers = new AgentProviders(directory)
  await providers.init()

  const workCodex = await providers.create({ template: "codex", name: "Work Codex", binaryPath: "/tools/codex", icon: "openai", inheritShellEnvironment: false, env: {} })
  const oldCodex = await providers.create({ template: "codex", name: "Old Codex", inheritShellEnvironment: false, env: { PATH: "/opt" } })
  const customCodex = await providers.create({ template: "codex", name: "Custom Codex", binaryPath: "/custom/codex", inheritShellEnvironment: false, env: {} })
  await providers.create({ template: "cursor", name: "Outdated Cursor", inheritShellEnvironment: false, env: { PATH: "/old-cursor" } })
  await providers.create({ template: "cursor", name: "Current Cursor", inheritShellEnvironment: false, env: { PATH: "/new-cursor" } })
  await providers.create({ template: "claude-code", name: "Missing Claude", inheritShellEnvironment: false, env: {} })
  await providers.create({ template: "acp", name: "Custom ACP", binaryPath: "/tools/custom-acp", inheritShellEnvironment: false, env: {} })
  await providers.create({ template: "deepseek-harness", name: "Bundled DSH", inheritShellEnvironment: false, env: {} })

  let fetchCalls = 0
  const updates = new ProviderUpdates(providers, {
    stopProviders: async () => {},
    probe: {
      platform: "linux",
      arch: "x64",
      env: { PATH: "/tools" },
      home: "/home/dev",
      cwd: "/home/dev",
      executable: async path => [
        "/tools/codex", "/opt/codex", "/custom/codex",
        "/old-cursor/cursor-agent", "/new-cursor/cursor-agent",
        "/tools/custom-acp", "/bin/bash",
      ].includes(path),
      run: (async (command, args) => {
        if (args[0] !== "--version") return ok("Logged in")
        if (command === "/custom/codex") return ok("codex-cli 0.140.0")
        if (command === "/opt/codex") return ok("codex-cli 0.150.0")
        if (command === "/old-cursor/cursor-agent") return ok("cursor-agent 2026.11.11-aaaaaaa")
        if (command === "/new-cursor/cursor-agent") return ok("cursor-agent 2026.11.11-bbbbbbb")
        return ok("codex-cli 0.160.0")
      }) as ProbeCommand,
    },
    fetch: (async input => {
      fetchCalls++
      if (String(input).includes("cursor.com")) {
        return new Response("DOWNLOAD_URL=\"https://downloads.cursor.com/lab/2026.11.11-bbbbbbb/linux/x64/agent.tar.gz\"")
      }
      return Response.json({ tag_name: "rust-v0.167.2" })
    }) as typeof fetch,
  })
  context.after(() => updates.close())

  let notifications = 0
  updates.onChanged(() => { notifications++ })

  await updates.check()
  assert.equal(fetchCalls, 2)
  assert.equal(notifications, 1)
  assert.deepEqual(updates.snapshot(), {
    codex: { currentVersion: "0.150.0", latestVersion: "0.167.2", status: "available" },
    cursor: { currentVersion: "2026.11.11-aaaaaaa", latestVersion: "2026.11.11-bbbbbbb", status: "available" },
  })

  await providers.remove(oldCodex.id)
  await updates.check()
  assert.deepEqual(updates.snapshot(), {
    codex: { currentVersion: "0.160.0", latestVersion: "0.167.2", status: "available" },
    cursor: { currentVersion: "2026.11.11-aaaaaaa", latestVersion: "2026.11.11-bbbbbbb", status: "available" },
  })

  // Removing the last default-path entry leaves only the custom binaryPath entry, which is ignored.
  await providers.remove(workCodex.id)
  await updates.check()
  assert.equal(updates.snapshot().codex, undefined)
  await assert.rejects(updates.upgrade("codex"), /No update is available/u)
  await providers.remove(customCodex.id)
  await providers.create({ template: "codex", name: "Fresh Codex", inheritShellEnvironment: false, env: {} })
  assert.equal(updates.snapshot().codex, undefined)
})

test("silent upgrade stops every entry of the CLI and handles failure + retry", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-upgrade-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const providers = new AgentProviders(directory)
  await providers.init()

  await providers.create({ template: "claude-code", name: "Pinned Claude", binaryPath: "/custom/claude", inheritShellEnvironment: false, env: {} })
  const claude = await providers.create({
    template: "claude-code",
    name: "Claude Code",
    inheritShellEnvironment: false,
    env: {},
  })
  const shared = await providers.create({ template: "claude-code", name: "Shared Claude", inheritShellEnvironment: false, env: {} })

  const peerProviders = new AgentProviders(join(directory, "peer"))
  await peerProviders.init()
  const peerClaude = await peerProviders.create({ template: "claude-code", name: "Peer Claude", inheritShellEnvironment: false, env: {} })

  const stopped: string[][] = []
  const peerStopped: string[][] = []
  let shouldFailInstall = true
  let claudeVersion = "2.1.190 (Claude Code)"
  let installGate = deferred()
  let installStarted = deferred()
  let peerChangedGate = deferred()

  const probe = {
    platform: "linux" as const,
    arch: "x64",
    env: { PATH: "/usr/local/bin" },
    home: "/home/dev",
    cwd: "/home/dev",
    executable: async (path: string) => ["/home/dev/.local/bin/claude", "/custom/claude", "/bin/bash"].includes(path),
    run: (async (command, args) => {
      if (command === "/bin/bash") {
        installStarted.resolve()
        await installGate.promise
        if (shouldFailInstall) {
          return { stdout: "", stderr: "curl: (6) Could not resolve host: claude.ai", code: 6 }
        }
        claudeVersion = "2.1.200 (Claude Code)"
        return ok("Installed 2.1.200")
      }
      if (args[0] === "--version") return ok(command === "/custom/claude" ? "2.1.150 (Claude Code)" : claudeVersion)
      return ok(JSON.stringify({ loggedIn: true }))
    }) as ProbeCommand,
  }
  const fetch = (async () => new Response("2.1.200\n")) as typeof globalThis.fetch
  const peerUpdates = new ProviderUpdates(peerProviders, {
    stopProviders: async ids => { peerStopped.push(ids) },
    probe,
    fetch,
  })
  const updates = new ProviderUpdates(providers, {
    stopProviders: async ids => { stopped.push(ids) },
    peers: () => [peerUpdates],
    probe,
    fetch,
  })
  context.after(async () => { await updates.close(); await peerUpdates.close() })

  await Promise.all([updates.check(), peerUpdates.check()])
  assert.equal(updates.snapshot()["claude-code"]?.status, "available")
  assert.equal(peerUpdates.snapshot()["claude-code"]?.status, "available")

  let changedGate = deferred()
  updates.onChanged(() => changedGate.resolve())
  peerUpdates.onChanged(() => peerChangedGate.resolve())

  await updates.upgrade("claude-code")
  assert.equal(updates.snapshot()["claude-code"]?.status, "updating")

  await installStarted.promise
  changedGate = deferred()
  installGate.resolve()
  await changedGate.promise

  assert.deepEqual(stopped, [[claude.id, shared.id]])
  assert.deepEqual(peerStopped, [[peerClaude.id]])
  assert.equal(updates.snapshot()["claude-code"]?.status, "error")
  assert.match(updates.snapshot()["claude-code"]?.error ?? "", /Could not resolve host/u)

  // Background re-check preserves the unread failure state for the same target version.
  await updates.check()
  assert.equal(updates.snapshot()["claude-code"]?.status, "error")

  // Retry succeeds and clears the notice on both co-hosted registrations.
  shouldFailInstall = false
  installGate = deferred()
  installStarted = deferred()
  peerChangedGate = deferred()
  await updates.upgrade("claude-code")
  assert.equal(updates.snapshot()["claude-code"]?.status, "updating")

  await installStarted.promise
  changedGate = deferred()
  installGate.resolve()
  await Promise.all([changedGate.promise, peerChangedGate.promise])

  assert.deepEqual(stopped, [[claude.id, shared.id], [claude.id, shared.id]])
  assert.deepEqual(peerStopped, [[peerClaude.id], [peerClaude.id]])
  assert.deepEqual(updates.snapshot(), {})
  assert.deepEqual(peerUpdates.snapshot(), {})
})

for (const manuallyUpdated of [false, true]) {
  test(manuallyUpdated ? "reconciles a manual update before upgrade without stopping sessions or reinstalling"
    : "silent Windows Codex upgrade disables installer prompts and verifies the installed version", async context => {
    const directory = await mkdtemp(join(tmpdir(), "df-codex-upgrade-"))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const providers = new AgentProviders(directory)
    await providers.init()
    const codex = await providers.create({ template: "codex", name: "Codex", inheritShellEnvironment: false, env: { CODEX_NON_INTERACTIVE: "0" } })
    let version = "0.160.0"
    let installs = 0
    let peerChecks = 0
    const stopped: string[][] = []
    const updates = new ProviderUpdates(providers, {
      stopProviders: async ids => { stopped.push(ids) },
      peers: () => [{ stopTemplate: async () => {}, check: async () => { peerChecks++ } }],
      fetch: (async () => Response.json({ version: "0.167.2" })) as typeof fetch,
      probe: {
        platform: "win32", arch: "x64", env: { PATH: "C:\\tools" }, home: "C:\\Users\\dev",
        executable: async path => ["C:\\tools\\codex.exe", "C:\\tools\\pwsh.exe"].includes(path),
        run: async (command, args, env) => {
          if (command === "C:\\tools\\pwsh.exe") {
            assert.ok(args.includes("-NonInteractive"))
            assert.equal(env.CODEX_NON_INTERACTIVE, "1")
            installs++
            version = "0.167.2"
            return ok("Installed")
          }
          assert.equal(env.CODEX_NON_INTERACTIVE, "0")
          return ok(args[0] === "--version" ? `codex-cli ${version}` : "Logged in")
        },
      },
    })
    context.after(() => updates.close())
    await updates.check()
    assert.equal(updates.snapshot().codex?.status, "available")
    if (manuallyUpdated) version = "0.168.0"

    const finished = deferred()
    updates.onChanged(() => { if (updates.snapshot().codex?.status !== "updating") finished.resolve() })
    await updates.upgrade("codex")
    await finished.promise

    assert.deepEqual(updates.snapshot(), {})
    assert.deepEqual(stopped, manuallyUpdated ? [] : [[codex.id]])
    assert.equal(installs, manuallyUpdated ? 0 : 1)
    assert.equal(peerChecks, 1)
  })
}
