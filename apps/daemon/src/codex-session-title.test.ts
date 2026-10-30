import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"

const adapter = readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8").replace(/\r\n/gu, "\n")

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type TitleSource = "unset" | "fallback" | "explicit"
type TitleResult = { turn: { items: { type: string; text: string }[] } }
interface TitleGenerator {
  inFlight: Promise<void> | null
  onTurnStarted(text: string): void
  markExistingTitle(): void
}
interface TitleClient {
  threadStart(params: { ephemeral: boolean }): Promise<{ thread: { id: string } }>
  runTurn(params: { threadId: string; input: { text: string }[] }): Promise<TitleResult>
  threadSetName(params: { threadId: string; name: string }): Promise<void>
}

const titleStart = adapter.indexOf("// src/TitleGenerator.ts")
const titleEnd = adapter.indexOf("// src/SessionIndexService.ts", titleStart)
assert.ok(titleStart >= 0 && titleEnd > titleStart, "Pinned adapter title generator exists")

// The adapter exports only its executable. Run its real generator and the real
// prompt-start callback against a fake app server, as in the other adapter tests.
const Generator = runInNewContext(`${adapter.slice(titleStart, titleEnd)}; TitleGenerator`, {
  setTimeout(callback: () => void) { queueMicrotask(callback); return 0 },
  clearTimeout() {},
}) as new (client: TitleClient, sessionId: string, cwd: string, titleSource: () => TitleSource) => TitleGenerator

const runTurnMatch = adapter.match(/^  async runTurn\(params, onTurnStarted\) \{[\s\S]*?^  \}/mu)
assert.ok(runTurnMatch, "Pinned adapter runTurn exists")
const runTurn = runInNewContext(`(${runTurnMatch[0].trimStart().replace("runTurn(", "function runTurn(")})`) as (
  this: {
    captureTurnCompletions(threadId: string, capture: (event: unknown) => void): () => void
    turnStart(params: { threadId: string }): Promise<{ turn: { id: string } }>
    awaitTurnCompleted(threadId: string, turnId: string): Promise<unknown>
  },
  params: { threadId: string },
  onTurnStarted: (turnId: string) => void,
) => Promise<unknown>

const promptStart = adapter.indexOf("  async promptAfterReservation(")
const sendPromptStart = adapter.indexOf("const sendPromptPromise =", promptStart)
const callbackStart = adapter.indexOf("(turnId) => {", sendPromptStart)
const callbackEnd = adapter.indexOf("\n          },\n          () => this.promptShouldStop", callbackStart)
assert.ok(promptStart >= 0 && sendPromptStart > promptStart && callbackStart > sendPromptStart && callbackEnd > callbackStart,
  "Pinned adapter normal prompt-start callback exists")
const callbackSource = adapter.slice(callbackStart, callbackEnd) + "\n          }"

function fixture(existingTitle = false) {
  const requested = deferred<void>()
  const titleResult = deferred<TitleResult>()
  const writes: { threadId: string; name: string }[] = []
  let generations = 0
  let cancelled = false
  let interrupted = 0
  const state: { sessionTitleSource: TitleSource; currentTurnId: string | null; titleGen?: TitleGenerator } = {
    sessionTitleSource: existingTitle ? "explicit" : "unset", currentTurnId: null,
  }
  const generator = new Generator({
    async threadStart(params) {
      assert.equal(params.ephemeral, true)
      return { thread: { id: "title-thread" } }
    },
    async runTurn(params) {
      generations++
      assert.equal(params.threadId, "title-thread")
      assert.ok(params.input[0]?.text.includes("Investigate the failing tests"))
      requested.resolve()
      return titleResult.promise
    },
    async threadSetName(params) { writes.push({ ...params }) },
  }, "main-thread", "/workspace", () => state.sessionTitleSource)
  state.titleGen = generator
  if (existingTitle) generator.markExistingTitle()
  const callback = runInNewContext(`(function () { return ${callbackSource}; }).call(host)`, {
    host: {
      promptShouldStop: () => cancelled,
      interruptLateStartedTurn() { interrupted++ },
    },
    params: { sessionId: "main-thread", prompt: [{ type: "text", text: "Investigate the failing tests" }] },
    activePrompt: {},
    sessionState: state,
    insertion: undefined,
    pendingTurnStart: undefined,
    priorRunningTurnId: null,
    onTurnStarted: undefined,
  }) as (turnId: string) => void

  function prompt(rejected = false) {
    const complete = deferred<unknown>()
    const started = deferred<void>()
    let settled = false
    const pending = runTurn.call({
      captureTurnCompletions() { return () => {} },
      async turnStart() {
        if (rejected) throw new Error("Prompt rejected")
        return { turn: { id: "main-turn" } }
      },
      awaitTurnCompleted() { return complete.promise },
    }, { threadId: "main-thread" }, turnId => { callback(turnId); started.resolve() })
    void pending.then(() => { settled = true }, () => { settled = true })
    return { pending, started: started.promise, finish: () => complete.resolve({ turn: { id: "main-turn" } }), get settled() { return settled } }
  }

  async function finishTitle() {
    titleResult.resolve({ turn: { items: [{ type: "agentMessage", text: '{"title":"Investigate failing tests"}' }] } })
    await generator.inFlight
  }
  return {
    state, generator, requested: requested.promise, writes, prompt, finishTitle,
    cancel() { cancelled = true },
    get generations() { return generations },
    get interrupted() { return interrupted },
  }
}

test("Codex titles the first prompt while its main turn is still running, only once", { timeout: 5_000 }, async () => {
  const fake = fixture()
  const first = fake.prompt()
  await first.started
  assert.ok(fake.generator.inFlight, "Title generation must start when the main turn starts")
  await fake.requested
  assert.equal(first.settled, false)
  await fake.finishTitle()
  assert.deepEqual(fake.writes, [{ threadId: "main-thread", name: "Investigate failing tests" }])
  assert.equal(first.settled, false, "The title must not wait for the main turn to finish")
  first.finish()
  await first.pending
  const second = fake.prompt()
  second.finish()
  await second.pending
  assert.equal(fake.generations, 1)
  assert.equal(fake.writes.length, 1)
})

test("Codex completes the main turn without waiting for its title", { timeout: 5_000 }, async () => {
  const fake = fixture()
  const prompt = fake.prompt()
  await prompt.started
  assert.ok(fake.generator.inFlight)
  await fake.requested
  prompt.finish()
  await prompt.pending
  assert.ok(fake.generator.inFlight)
  assert.equal(fake.writes.length, 0)
  await fake.finishTitle()
  assert.equal(fake.writes.length, 1)
})

test("Codex retains an existing title and a rename made during title generation", { timeout: 5_000 }, async context => {
  await context.test("existing title", async () => {
    const fake = fixture(true)
    const prompt = fake.prompt()
    prompt.finish()
    await prompt.pending
    assert.equal(fake.generations, 0)
    assert.equal(fake.writes.length, 0)
  })
  await context.test("rename while generation is pending", async () => {
    const fake = fixture()
    const prompt = fake.prompt()
    await prompt.started
    assert.ok(fake.generator.inFlight)
    await fake.requested
    fake.state.sessionTitleSource = "explicit"
    await fake.finishTitle()
    assert.equal(fake.writes.length, 0)
    prompt.finish()
    await prompt.pending
  })
})

test("Codex does not generate a title when turn startup is rejected or cancelled", async context => {
  await context.test("rejected startup", async () => {
    const fake = fixture()
    await assert.rejects(fake.prompt(true).pending, /Prompt rejected/u)
    assert.equal(fake.generations, 0)
  })
  await context.test("cancelled before turn-start acknowledgement", async () => {
    const fake = fixture()
    fake.cancel()
    const prompt = fake.prompt()
    prompt.finish()
    await prompt.pending
    assert.equal(fake.interrupted, 1)
    assert.equal(fake.generations, 0)
  })
})
