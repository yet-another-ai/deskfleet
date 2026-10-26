import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import { DaemonClient } from "../../desktop/src/main/daemon-client.ts"
import { startDaemon } from "./daemon.ts"

test("authenticated provider CRUD broadcasts changes and survives daemon restart", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-control-"))
  let starting: ReturnType<typeof startDaemon> | undefined
  const clients: DaemonClient[] = []
  t.after(async () => {
    clients.forEach(client => client.close())
    try { await (await starting)?.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const own = (client: DaemonClient): DaemonClient => {
    clients.push(client)
    if (t.signal.aborted) { client.close(); t.signal.throwIfAborted() }
    return client
  }
  const options = {
    allowLocalControlForTests: true, controlDirectory: directory,
    // Provider settings persist in agent-providers.json, independently of SQLite.
    // Each daemon still gets a new catalog; this test does not retain catalog state.
    openCatalog: (_path: string, name: string) => openInMemoryCatalog(name),
    requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null,
  }
  starting = startDaemon(0, options)
  let daemon = await starting
  t.signal.throwIfAborted()
  const client = own(await DaemonClient.connect(() => {}, () => {}, directory))
  let changed: (() => void) | undefined
  const observer = own(await DaemonClient.connect(event => { if (event.kind === "providersChanged") changed?.() }, () => {}, directory))
  assert.equal((await client.call("providerList", {})).providers[0]?.id, "codex")
  const missing = { template: "acp" as const, name: "Missing", binaryPath: join(directory, "missing-binary"), env: {} }
  assert.equal((await client.call("providerProbe", { provider: missing })).status, "missing")
  await assert.rejects(client.call("providerInstall", { provider: missing }))
  await assert.rejects(client.call("providerLogin", { provider: missing }))
  const notification = new Promise<void>(resolve => { changed = resolve })
  const created = await client.call("providerCreate", { provider: { template: "acp", name: "Custom", env: { API_KEY: "private" } } })
  await notification
  const updated = await client.call("providerUpdate", { providerId: created.id, changes: { name: "Work", binaryPath: "/usr/local/bin/acp", env: { MODE: "work" } } })
  assert.equal(updated.template, "acp")
  assert.deepEqual((await observer.call("providerList", {})).providers.find(provider => provider.id === created.id), updated)
  if (process.platform !== "win32") {
    // A slow test runs beside other requests on the same connection.
    const silent = join(directory, "silent-agent")
    await writeFile(silent, "#!/bin/sh\nsleep 2\n", { mode: 0o700 })
    let settled = false
    const testing = client.call("providerTest", { provider: { template: "acp", name: "Silent", binaryPath: silent, env: {} } })
      .finally(() => { settled = true })
    assert.equal((await client.call("providerList", {})).providers.length, 2)
    assert.equal(settled, false)
    await assert.rejects(testing, /closed|exited/u)
  }
  await client.call("providerRemove", { providerId: "codex" })
  clients.forEach(connection => connection.close())
  await daemon.close()
  assert.deepEqual(JSON.parse(await readFile(join(directory, "agent-providers.json"), "utf8")).providers, [updated])
  t.signal.throwIfAborted()
  starting = startDaemon(0, options)
  daemon = await starting
  t.signal.throwIfAborted()
  const reopened = own(await DaemonClient.connect(() => {}, () => {}, directory))
  assert.deepEqual((await reopened.call("providerList", {})).providers, [updated])
  await reopened.call("providerRemove", { providerId: created.id })
  assert.deepEqual((await reopened.call("providerList", {})).providers, [])
})
