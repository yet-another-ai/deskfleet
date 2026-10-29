import { afterEach, expect, test, vi } from "vitest"
import { observePeerGrant, setPeerTelemetrySink } from "./peer-telemetry.ts"

afterEach(() => setPeerTelemetrySink(undefined))

test.each(["free_plan", "turn_quota_exhausted", "metering_unavailable"] as const)("records %s without credentials or target identifiers in metadata", relayDeniedReason => {
  const sink = vi.fn()
  setPeerTelemetrySink(sink)
  const telemetry = observePeerGrant("files", { iceServers: [{ urls: "stun:private.example" }], relayDeniedReason }, "team")
  telemetry.connected()
  expect(sink.mock.calls.map(([event]) => event)).toEqual([
    { name: "peer_granted", teamId: "team", metadata: { feature: "files", relay: relayDeniedReason } },
    { name: "peer_connection", teamId: "team", metadata: { feature: "files", relay: relayDeniedReason, outcome: "connected", transport: "unknown" } },
  ])
})

test("TURN credentials grant fallback access without claiming a selected relay path", () => {
  const sink = vi.fn()
  setPeerTelemetrySink(sink)
  const telemetry = observePeerGrant("desktop", { iceServers: [{ urls: ["turns:private.example"], username: "sensitive-user", credential: "secret" }] }, "team")
  telemetry.connected()
  telemetry.connected()
  telemetry.failed()
  expect(sink.mock.calls.map(([event]) => event)).toEqual([
    { name: "peer_granted", teamId: "team", metadata: { feature: "desktop", relay: "allowed" } },
    { name: "peer_connection", teamId: "team", metadata: { feature: "desktop", relay: "allowed", outcome: "connected", transport: "unknown" } },
  ])
})

test("a failed attempt is recorded once and STUN alone does not grant relay", () => {
  const sink = vi.fn()
  setPeerTelemetrySink(sink)
  const telemetry = observePeerGrant("terminal", { iceServers: [{ urls: "stun:private.example" }] }, "team")
  telemetry.failed()
  telemetry.failed()
  telemetry.connected()
  expect(sink).toHaveBeenLastCalledWith({ name: "peer_connection", teamId: "team", metadata: { feature: "terminal", relay: "unconfigured", outcome: "failed", transport: "unknown" } })
  expect(sink).toHaveBeenCalledTimes(2)
})

test("telemetry is optional and a failed observer cannot affect peers", () => {
  expect(() => observePeerGrant("agent", { iceServers: [] }, "team").connected()).not.toThrow()
  setPeerTelemetrySink(() => { throw new Error("Observer failed") })
  expect(() => observePeerGrant("agent", { iceServers: [] }, "team").failed()).not.toThrow()
})

test("cleanup cannot remove a newer host's telemetry sink", () => {
  const first = vi.fn(), second = vi.fn()
  const stopFirst = setPeerTelemetrySink(first)
  const stopSecond = setPeerTelemetrySink(second)
  stopFirst()
  observePeerGrant("ports", { iceServers: [] }, "team")
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledOnce()
  stopSecond()
  observePeerGrant("ports", { iceServers: [] }, "team")
  expect(second).toHaveBeenCalledOnce()
})
