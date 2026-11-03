import assert from "node:assert/strict"
import test from "node:test"
import { PeerAdmission } from "./peer-admission.ts"
import type { ControlPeers } from "./control-server.ts"

test("registrations share capacity, closing releases once, and replay protection lasts until expiry", () => {
  const host = {} as ControlPeers
  const a = PeerAdmission.for(host), b = PeerAdmission.for(host)
  assert.equal(a, b)
  const releases = Array.from({ length: 128 }, (_, i) => a.reserve(`peer-${i}`, 100, 0))
  assert.throws(() => b.reserve("overflow", 100, 0), /capacity/)
  releases[0]!(); releases[0]!()
  assert.throws(() => b.reserve("peer-0", 100, 0), /new peer/)
  const release = b.reserve("replacement", 100, 0)
  assert.throws(() => a.reserve("overflow", 100, 0), /capacity/)
  release()
  a.reserve("peer-0", 200, 101)()
  releases.forEach(release => release())
})

test("replay capacity rejects new grants instead of evicting valid tombstones", () => {
  const admission = new PeerAdmission()
  for (let i = 0; i < 16_384; i++) admission.reserve(`peer-${i}`, 100, 0)()
  assert.throws(() => admission.reserve("overflow", 100, 0), /capacity/)
  assert.throws(() => admission.reserve("peer-0", 100, 0), /new peer/)
  admission.reserve("fresh", 200, 101)()
})
