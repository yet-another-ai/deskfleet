import assert from "node:assert/strict"
import test from "node:test"
import { scheduleInput, scheduleTrigger } from "./schedule-protocol.ts"
import { nextScheduleTime } from "./schedule-time.ts"

test("daily and weekly schedules follow their explicit time zone", () => {
  assert.equal(nextScheduleTime({ kind: "daily", time: "09:00", timeZone: "Asia/Singapore" }, new Date("2026-10-26T00:00:00Z")), "2026-10-26T01:00:00.000Z")
  assert.equal(nextScheduleTime({ kind: "weekly", time: "09:00", timeZone: "Asia/Singapore", weekdays: [1] }, new Date("2026-10-26T01:00:00Z")), "2026-11-02T01:00:00.000Z")
  assert.equal(nextScheduleTime({ kind: "interval", minutes: 15 }, new Date("2026-10-26T01:03:12Z")), "2026-10-26T01:18:12.000Z")
  assert.equal(nextScheduleTime({ kind: "manual" }, new Date()), undefined)
})

test("DST gaps skip a missing time and folds execute only the first occurrence", () => {
  assert.equal(nextScheduleTime({ kind: "daily", time: "02:30", timeZone: "America/New_York" }, new Date("2026-03-08T05:00:00Z")), "2026-03-09T06:30:00.000Z")
  assert.equal(nextScheduleTime({ kind: "daily", time: "01:30", timeZone: "America/New_York" }, new Date("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z")
  assert.equal(nextScheduleTime({ kind: "daily", time: "01:30", timeZone: "America/New_York" }, new Date("2026-11-01T05:30:00Z")), "2026-11-02T06:30:00.000Z")
  assert.equal(nextScheduleTime({ kind: "weekly", time: "02:30", timeZone: "America/New_York", weekdays: [0] }, new Date("2026-03-08T05:00:00Z")), "2026-03-15T06:30:00.000Z")
})

test("non-hour offsets and DST transitions retain wall time", () => {
  assert.equal(nextScheduleTime({ kind: "daily", time: "09:00", timeZone: "Asia/Kathmandu" }, new Date("2026-10-26T00:00:00Z")), "2026-10-26T03:15:00.000Z")
  assert.equal(nextScheduleTime({ kind: "daily", time: "02:15", timeZone: "Australia/Lord_Howe" }, new Date("2026-10-03T13:00:00Z")), "2026-10-04T15:15:00.000Z")
})

test("browser time values with seconds normalize to HH:mm", () => {
  assert.deepEqual(scheduleTrigger({ kind: "daily", time: "14:30:00", timeZone: "UTC" }), { kind: "daily", time: "14:30", timeZone: "UTC" })
  assert.deepEqual(scheduleTrigger({ kind: "weekly", time: "09:05:07.250", timeZone: "UTC", weekdays: [1] }), { kind: "weekly", time: "09:05", timeZone: "UTC", weekdays: [1] })
  assert.deepEqual(scheduleInput({ title: "Task", prompt: "Review", workspaceId: "1", enabled: true, target: { kind: "existing", sessionId: "1" }, trigger: { kind: "daily", time: "08:15:00", timeZone: "UTC" } }).trigger, { kind: "daily", time: "08:15", timeZone: "UTC" })
  assert.throws(() => scheduleTrigger({ kind: "daily", time: "14:30:60", timeZone: "UTC" }), /HH:mm/u)
})

test("schedule parsing rejects invalid timing, targets, and empty prompts", () => {
  assert.throws(() => scheduleTrigger({ kind: "daily", time: "24:00", timeZone: "UTC" }), /HH:mm/u)
  assert.throws(() => scheduleTrigger({ kind: "daily", time: "09:00", timeZone: "unknown" }), /time zone/u)
  assert.throws(() => scheduleTrigger({ kind: "weekly", time: "09:00", timeZone: "UTC", weekdays: [] }), /weekday/u)
  assert.throws(() => scheduleTrigger({ kind: "interval", minutes: 0.5 }), /interval/u)
  assert.throws(() => scheduleInput({ title: "Task", prompt: " ", workspaceId: "1", enabled: true, target: { kind: "existing", sessionId: "1" }, trigger: { kind: "manual" } }), /prompt/u)
})
