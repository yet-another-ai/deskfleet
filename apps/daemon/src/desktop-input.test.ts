import assert from "node:assert/strict"
import test from "node:test"
import { DesktopInputChannel, DESKTOP_INPUT_CHANNEL } from "./desktop-input.ts"

function fixture() {
  const input: string[] = [], output: string[] = []
  const settings: { audio?: boolean; control?: boolean }[] = []
  let allowed = true, controlAllowed = true
  const peer = {
    sendText: async (label, text) => { assert.equal(label, DESKTOP_INPUT_CHANNEL); output.push(text) },
    sendDesktopInput: async text => { input.push(text) },
    setDesktopAudio: async (audio: boolean) => { settings.push({ audio }) },
    setDesktopControl: async (control: boolean) => { settings.push({ control }) },
  } satisfies ConstructorParameters<typeof DesktopInputChannel>[0]
  const authorize = () => { if (!allowed) throw new Error("revoked") }
  const channel = new DesktopInputChannel(peer, authorize, () => {
    authorize()
    if (!controlAllowed) throw new Error("control denied")
  })
  const data = (text: string, isString = true) => channel.receive({ kind: "data", label: DESKTOP_INPUT_CHANNEL, data: Buffer.from(text), isString })
  const configure = (requestId: number, audio: boolean, control: boolean) => data(JSON.stringify({ type: "configure", requestId, audio, control }))
  return { channel, peer, input, output, settings, data, configure, revoke() { allowed = false }, denyControl() { controlAllowed = false } }
}

test("input is ready only after both capture control and its channel are ready", async () => {
  for (const first of ["channel", "capture"]) {
    const f = fixture()
    const open = () => f.channel.receive({ kind: "dataChannelOpen", label: DESKTOP_INPUT_CHANNEL })
    await (first === "channel" ? open() : f.channel.started(true))
    assert.deepEqual(f.output, [])
    await (first === "channel" ? f.channel.started(true) : open())
    assert.deepEqual(f.output, ['{"type":"ready"}'])
    await f.data('{"type":"key","code":"KeyA","pressed":true,"repeat":false}')
    await f.channel.receive({ kind: "stateChanged", state: "disconnected" })
    assert.deepEqual(f.input, ['{"type":"key","code":"KeyA","pressed":true,"repeat":false}', '{"type":"releaseAll"}'])
  }
})

test("view-only, revoked, malformed and closed channels cannot inject input", async () => {
  const f = fixture()
  await assert.rejects(f.data('{}'), /not enabled/)
  await f.channel.started(true)
  await assert.rejects(f.data('{}', false), /Invalid/)
  await assert.rejects(f.data(' '.repeat(4097)), /Invalid/)
  f.revoke()
  await assert.rejects(f.data('{}'), /revoked/)
  f.channel.close()
  await f.data('{}')
  assert.deepEqual(f.input, [])
})

test("live configuration disables and reenables control on the same channel", async () => {
  const f = fixture()
  await f.channel.started(true)
  await f.channel.receive({ kind: "dataChannelOpen", label: DESKTOP_INPUT_CHANNEL })
  await f.data('{"type":"key","code":"KeyA","pressed":true,"repeat":false}')
  await f.configure(1, false, false)
  await f.data('{"type":"key","code":"KeyA","pressed":false,"repeat":false}')
  await f.data('{"type":"releaseAll"}')
  assert.equal(f.input.length, 1)
  assert.deepEqual(f.settings, [{ audio: false }, { control: false }])
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configured", requestId: 1, control: false })
  await f.configure(2, true, true)
  await f.data('{"type":"key","code":"KeyB","pressed":true,"repeat":false}')
  assert.equal(f.input.length, 2)
  assert.deepEqual(f.settings.slice(2), [{ audio: true }, { control: true }])
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configured", requestId: 2, control: true })
})

test("a view-only stream can enable control after capture starts", async () => {
  const f = fixture()
  await f.channel.started(false)
  await f.channel.receive({ kind: "dataChannelOpen", label: DESKTOP_INPUT_CHANNEL })
  assert.deepEqual(f.output, [])
  await f.configure(1, true, true)
  await f.data('{"type":"releaseAll"}')
  assert.deepEqual(f.input, ['{"type":"releaseAll"}'])
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configured", requestId: 1, control: true })
})

test("disabling control waits for native held-input cleanup before acknowledging", async () => {
  const f = fixture()
  await f.channel.started(true)
  let release!: () => void
  const stopped = new Promise<void>(resolve => { release = resolve })
  f.peer.setDesktopControl = async control => { assert.equal(control, false); await stopped }
  const configuring = f.configure(1, false, false)
  await Promise.resolve()
  assert.deepEqual(f.output, [])
  release()
  await configuring
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configured", requestId: 1, control: false })
})

test("audio and disabling control need a live stream grant; enabling also needs control", async () => {
  const f = fixture()
  await f.channel.started(true)
  f.denyControl()
  await f.configure(1, false, false)
  assert.deepEqual(f.settings, [{ audio: false }, { control: false }])
  await f.configure(2, true, true)
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configurationError", requestId: 2, control: false, error: "control denied" })
  assert.equal(f.settings.length, 2)
  f.revoke()
  await f.configure(3, true, false)
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configurationError", requestId: 3, control: false, error: "revoked" })
  assert.equal(f.settings.length, 2)
})

test("configuration requires capture startup and valid settings without injecting them as input", async () => {
  const f = fixture()
  await f.configure(1, true, true)
  assert.match(f.output.at(-1)!, /has not started/)
  await f.channel.started(false)
  await f.data('{"type":"configure","requestId":2,"audio":true,"control":1}')
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configurationError", requestId: 2, control: false, error: "Invalid desktop configuration" })
  await assert.rejects(f.data('{"type":"configure","requestId":-1,"audio":true,"control":true}'), /request ID/)
  assert.deepEqual(f.settings, [])
  assert.deepEqual(f.input, [])
})

test("revocation during audio configuration prevents acquiring input", async () => {
  const f = fixture()
  await f.channel.started(false)
  f.peer.setDesktopAudio = async () => { f.revoke() }
  await f.configure(1, true, true)
  assert.deepEqual(f.settings, [])
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configurationError", requestId: 1, control: false, error: "revoked" })
})

test("native configuration failures preserve control state and allow another settings request", async () => {
  const f = fixture()
  await f.channel.started(false)
  const setControl = f.peer.setDesktopControl
  f.peer.setDesktopControl = async () => { throw new Error("desktop control needs Accessibility permission on the remote Mac") }
  await f.configure(1, true, true)
  assert.deepEqual(JSON.parse(f.output.at(-1)!), {
    type: "configurationError", requestId: 1, control: false, reason: "accessibility",
    error: "desktop control needs Accessibility permission on the remote Mac",
  })
  f.peer.setDesktopControl = setControl
  await f.configure(2, false, true)
  await f.data('{"type":"releaseAll"}')
  assert.deepEqual(f.input, ['{"type":"releaseAll"}'])
  assert.deepEqual(JSON.parse(f.output.at(-1)!), { type: "configured", requestId: 2, control: true })
})

test("failed native disable cleanup still acknowledges disabled control and drains queued input", async () => {
  const f = fixture()
  await f.channel.started(true)
  f.peer.setDesktopControl = async () => { throw new Error("held-input cleanup failed") }
  await f.configure(1, false, false)
  await f.data('{"type":"releaseAll"}')
  assert.deepEqual(f.input, [])
  assert.deepEqual(JSON.parse(f.output.at(-1)!), {
    type: "configurationError", requestId: 1, control: false, error: "held-input cleanup failed",
  })
})
