import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"

const adapter = readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8")
const start = adapter.indexOf("// src/app-server-recovery/CodexAppServerSupervisor.ts")
const end = adapter.indexOf("// src/app-server-recovery/LossAwareConnection.ts", start)
assert.ok(start >= 0 && end > start, "Pinned adapter supervisor exists")

/** Exercise the actual pinned patch, as the published adapter only exports an executable. */
function fixture() {
  let timerId = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const signals: string[] = []
  let ended = 0
  let disposed = 0
  let destroyed = 0
  const stream = () => Object.assign(new EventEmitter(), { destroy() { destroyed++ } })
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: { end() { ended++ }, destroy() { destroyed++ } },
    stdout: stream(),
    stderr: stream(),
    kill(signal: string) { signals.push(signal) },
  })
  let drained!: () => void
  const connection = {
    process: child,
    connection: { dispose() { disposed++ } },
    drained: new Promise<void>(resolve => { drained = resolve }),
  }
  const Supervisor = runInNewContext(`${adapter.slice(start, end)}; CodexAppServerSupervisor`, {
    logger: { log() {}, error() {} },
    setTimeout(callback: () => void, delay: number) {
      timers.set(++timerId, { callback, delay })
      return timerId
    },
    clearTimeout(id: number) { timers.delete(id) },
  }) as new (state: { connection: typeof connection; stderr: string }) => {
    shutdown(): void
    stop(): Promise<unknown>
  }
  const supervisor = new Supervisor({ connection, stderr: "" })
  function tick(delay: number) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay)
    assert.ok(entry, `Expected a ${delay} ms deadline`)
    timers.delete(entry[0])
    entry[1].callback()
  }
  function observeExit() { child.emit("exit", 0, null) }
  function finishDrain() {
    child.stdout.emit("end")
    drained()
    child.emit("close", 0, null)
  }
  async function exit() {
    observeExit()
    finishDrain()
    await supervisor.stop()
  }
  return {
    supervisor, timers, signals, tick, exit, observeExit, finishDrain,
    get ended() { return ended },
    get disposed() { return disposed },
    get destroyed() { return destroyed },
  }
}

test("Codex metadata process shutdown releases the grace timer when its child exits", async () => {
  const fake = fixture()
  fake.supervisor.shutdown()
  fake.supervisor.shutdown()
  assert.equal(fake.ended, 1)
  assert.deepEqual([...fake.timers.values()].map(timer => timer.delay), [2_000])
  await fake.exit()
  assert.equal(fake.timers.size, 0, "A completed discovery must not wait for a leftover two-second timer")
  assert.deepEqual(fake.signals, [])
  assert.equal(fake.disposed, 1)
  assert.equal(fake.destroyed, 3)
})

test("Codex shutdown retains SIGTERM fallback and clears its timer after child exit", async () => {
  const fake = fixture()
  fake.supervisor.shutdown()
  fake.tick(2_000)
  assert.deepEqual(fake.signals, ["SIGTERM"])
  assert.deepEqual([...fake.timers.values()].map(timer => timer.delay), [5_000])
  await fake.exit()
  assert.equal(fake.timers.size, 0)
  assert.equal(fake.disposed, 1)
})

test("Codex shutdown still waits for final stdout after releasing the termination timer", async () => {
  const fake = fixture()
  fake.supervisor.shutdown()
  let stopped = false
  const stopping = fake.supervisor.stop().then(() => { stopped = true })
  fake.observeExit()
  await Promise.resolve()
  assert.equal(stopped, false)
  assert.equal(fake.disposed, 0)
  assert.deepEqual([...fake.timers.values()].map(timer => timer.delay), [1_000])
  fake.finishDrain()
  await stopping
  assert.equal(fake.timers.size, 0)
  assert.equal(fake.disposed, 1)
})

test("Codex shutdown still settles a child that never exits after SIGTERM", async () => {
  const fake = fixture()
  fake.supervisor.shutdown()
  fake.tick(2_000)
  fake.tick(5_000)
  await fake.supervisor.stop()
  assert.deepEqual(fake.signals, ["SIGTERM"])
  assert.equal(fake.timers.size, 0)
  assert.equal(fake.disposed, 1)
  assert.equal(fake.destroyed, 3)
})
