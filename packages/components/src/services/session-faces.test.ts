import { expect, test } from "vitest"
import { sessionFaces } from "./session-faces.ts"

test("people who are here come before people who only visited", () => {
  const faces = sessionFaces(
    [{ userId: "ada", seenAt: "2026-11-01T00:00:00Z" }, { userId: "grace", seenAt: "2026-11-02T00:00:00Z" }],
    ["ada"],
    userId => ({ name: userId === "ada" ? "Ada Lovelace" : "Grace Hopper", email: `${userId}@example.test` }),
  )
  expect(faces).toEqual([
    { id: "ada", name: "Ada Lovelace", email: "ada@example.test", active: true },
    { id: "grace", name: "Grace Hopper", email: "grace@example.test", active: false },
  ])
})

test("someone here before their visit is recorded still appears first", () => {
  const faces = sessionFaces(
    [{ userId: "grace", seenAt: "2026-11-02T00:00:00Z" }],
    ["ada"],
    userId => ({ name: userId, email: null }),
  )
  expect(faces.map(face => [face.id, face.active])).toEqual([["ada", true], ["grace", false]])
})
