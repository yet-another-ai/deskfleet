import assert from "node:assert/strict"
import test from "node:test"
import { DesktopInputChannel, DESKTOP_INPUT_CHANNEL } from "./desktop-input.ts"

function fixture() {
  const input: string[] = [], output: string[] = []
  let allowed = true
  const channel = new DesktopInputChannel({
    sendText: async (label, text) => { assert.equal(label, DESKTOP_INPUT_CHANNEL); output.push(text) },
    sendDesktopInput: async text => { input.push(text) },
  }, () => { if (!allowed) throw new Error("revoked") })
  const data = (text: string, isString = true) => channel.receive({ kind: "data", label: DESKTOP_INPUT_CHANNEL, data: Buffer.from(text), isString })
  return { channel, input, output, data, revoke() { allowed = false } }
}

test("input is ready only after both capture control and its channel are ready", async () => {
  for (const first of ["channel", "capture"]) {
    const f = fixture()
    const open = () => f.channel.receive({ kind: "dataChannelOpen", label: DESKTOP_INPUT_CHANNEL })
    await (first === "channel" ? open() : f.channel.enable())
    assert.deepEqual(f.output, [])
    await (first === "channel" ? f.channel.enable() : open())
    assert.deepEqual(f.output, ['{"type":"ready"}'])
    await f.data('{"type":"key","code":"KeyA","pressed":true,"repeat":false}')
    await f.channel.receive({ kind: "stateChanged", state: "disconnected" })
    assert.deepEqual(f.input, ['{"type":"key","code":"KeyA","pressed":true,"repeat":false}', '{"type":"releaseAll"}'])
  }
})

test("view-only, revoked, malformed and closed channels cannot inject input", async () => {
  const f = fixture()
  await assert.rejects(f.data('{}'), /not enabled/)
  await f.channel.enable()
  await assert.rejects(f.data('{}', false), /Invalid/)
  await assert.rejects(f.data(' '.repeat(4097)), /Invalid/)
  f.revoke()
  await assert.rejects(f.data('{}'), /revoked/)
  f.channel.close()
  await f.data('{}')
  assert.deepEqual(f.input, [])
})
