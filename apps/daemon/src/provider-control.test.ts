import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { DaemonClient } from "../../desktop/src/main/daemon-client.ts"
import { startDaemon } from "./daemon.ts"

test("authenticated provider CRUD broadcasts changes and survives daemon restart", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-control-"))
  let daemon = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  const clients: DaemonClient[] = []
  t.after(async () => {
    clients.forEach(client => client.close())
    await daemon.close()
    await rm(directory, { recursive: true, force: true })
  })
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  let changed: (() => void) | undefined
  const observer = await DaemonClient.connect(event => { if (event.kind === "providersChanged") changed?.() }, () => {}, directory)
  clients.push(client, observer)
  assert.equal((await client.call("providerList", {})).providers[0]?.id, "codex")
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
  daemon = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  const reopened = await DaemonClient.connect(() => {}, () => {}, directory)
  clients.push(reopened)
  assert.deepEqual((await reopened.call("providerList", {})).providers, [updated])
  await reopened.call("providerRemove", { providerId: created.id })
  assert.deepEqual((await reopened.call("providerList", {})).providers, [])
})
