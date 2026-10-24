import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { DaemonClient } from "../../desktop/src/main/daemon-client.ts"
import { startDaemon } from "./daemon.ts"

test("authenticated provider CRUD broadcasts changes and survives daemon restart", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-control-"))
  let daemon = await startDaemon(0, { controlDirectory: directory, requestScreenCaptureAccess: async () => null })
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
  await client.call("providerRemove", { providerId: "codex" })
  clients.forEach(connection => connection.close())
  await daemon.close()
  daemon = await startDaemon(0, { controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  const reopened = await DaemonClient.connect(() => {}, () => {}, directory)
  clients.push(reopened)
  assert.deepEqual((await reopened.call("providerList", {})).providers, [updated])
  await reopened.call("providerRemove", { providerId: created.id })
  assert.deepEqual((await reopened.call("providerList", {})).providers, [])
})
