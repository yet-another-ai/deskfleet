import assert from "node:assert/strict"
import test from "node:test"
import { SessionPresence } from "./session-presence.ts"

test("one person on several connections stays a single viewer until the last connection leaves", () => {
  const presence = new SessionPresence()
  const updates: string[][] = []
  presence.onChange(update => { if (update.sessionId === "1") updates.push(update.userIds) })
  presence.watch("1", "browser", "bob")
  presence.watch("1", "desktop", "bob")
  presence.watch("1", "browser", "bob")
  presence.watch("2", "browser", "ada")
  assert.deepEqual(presence.snapshot(), [
    { sessionId: "1", userIds: ["bob"] },
    { sessionId: "2", userIds: ["ada"] },
  ])
  presence.unwatch("1", "browser")
  assert.deepEqual(presence.userIds("1"), ["bob"])
  presence.disconnect("desktop")
  presence.disconnect("browser")
  assert.deepEqual(presence.snapshot(), [])
  assert.deepEqual(updates, [["bob"], ["bob"], ["bob"], []])
})
