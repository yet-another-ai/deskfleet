import assert from "node:assert/strict"
import test from "node:test"
import manifest from "../package.json" with { type: "json" }
import { MachineOperations } from "./machine-operations.ts"
import type { SystemStatus } from "./system-protocol.ts"

const status: SystemStatus = {
  daemonVersion: "2.3.4",
  sampledAt: 1_793_000_000_000,
  cpuUsagePercent: 37.5,
  memoryUsedBytes: 8_589_934_592,
  memoryTotalBytes: 17_179_869_184,
  swapUsedBytes: 0,
  swapTotalBytes: 4_294_967_296,
  uptimeSeconds: 3600,
  cpuModel: "Test CPU",
  logicalCpuCount: 8,
  os: "Test OS",
  arch: "aarch64",
}

const actor = { kind: "user" as const, userId: "member", deviceId: "login" }

function fixture(sample?: () => Promise<SystemStatus>) {
  return new MachineOperations({
    agents: {}, catalog: {}, terminals: {}, providers: {}, setup: {},
    capabilities: async () => ({ displays: [], audio: false }),
    systemStatus: sample,
  } as unknown as ConstructorParameters<typeof MachineOperations>[0])
}

test("system status includes the running daemon's package version", async () => {
  const result = await fixture().handle("systemStatus", {}, actor) as SystemStatus
  assert.equal(result.daemonVersion, manifest.version)
})

test("system status requires the server-verified user and login before sampling", async () => {
  let reads = 0
  const operations = fixture(async () => { reads++; return status })
  for (const unverified of [undefined, { kind: "local_token" as const }, { ...actor, deviceId: "" }]) {
    await assert.rejects(operations.handle("systemStatus", { userId: "member", deviceId: "login" }, unverified), /verified user and login/)
  }
  assert.equal(reads, 0)
  assert.deepEqual(await operations.handle("systemStatus", {}, actor), status)
  assert.equal(reads, 1)
})

test("system status rejects malformed parameters and preserves native sampling failures", async () => {
  let reads = 0
  const failure = new Error("System metrics are unavailable")
  const operations = fixture(async () => { reads++; throw failure })
  await assert.rejects(operations.handle("systemStatus", null, actor), /Expected an object/)
  assert.equal(reads, 0)
  await assert.rejects(operations.handle("systemStatus", {}, actor), error => error === failure)
  assert.equal(reads, 1)
})

test("Session rename passes only the server-verified actor to the Agent service", async () => {
  const calls: unknown[][] = []
  const operations = new MachineOperations({
    agents: { handle: async (...args: unknown[]) => { calls.push(args); return { renamed: true } } },
    catalog: {}, terminals: {}, providers: {}, setup: {}, capabilities: async () => ({ displays: [], audio: false }),
  } as unknown as ConstructorParameters<typeof MachineOperations>[0])
  const params = { sessionId: "1", operationId: "rename", title: "New title", actor }
  await assert.rejects(operations.handle("_deskfleet/session/rename", params, undefined), /verified user and login/u)
  assert.deepEqual(calls, [])
  assert.deepEqual(await operations.handle("_deskfleet/session/rename", params, actor), { renamed: true })
  assert.deepEqual(calls, [["_deskfleet/session/rename", params, actor]])
})

test("Session read acknowledgement passes the server-verified actor to the Agent service", async () => {
  const calls: unknown[][] = []
  const operations = new MachineOperations({
    agents: { handle: async (...args: unknown[]) => { calls.push(args); return { read: true } } },
    catalog: {}, terminals: {}, providers: {}, setup: {}, capabilities: async () => ({ displays: [], audio: false }),
  } as unknown as ConstructorParameters<typeof MachineOperations>[0])
  const params = { sessionId: "1", operationId: "read", throughSeq: "5", actor: { userId: "spoof" } }
  await assert.rejects(operations.handle("_deskfleet/session/read", params, undefined), /verified user and login/u)
  assert.deepEqual(calls, [])
  assert.deepEqual(await operations.handle("_deskfleet/session/read", params, actor), { read: true })
  assert.deepEqual(calls, [["_deskfleet/session/read", params, actor]])
})
