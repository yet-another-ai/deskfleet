import assert from "node:assert/strict"
import test from "node:test"
import { quintFiles, runNames } from "./check-specs.ts"

test("spec check selects Quint models and ignores notes beside them", () => {
  assert.deepEqual(quintFiles(["notes.md", "grant_lifecycle.qnt", "route_fence.qnt"]), [
    "grant_lifecycle.qnt",
    "route_fence.qnt",
  ])
  assert.deepEqual(quintFiles([]), [])
})

test("spec check selects run definitions by name", () => {
  const source = `
    action step = init
    run signaling_loss_keeps_established_peer = init
    run changed_offer_keeps_binding = init
    val inv_binding_stable = true
  `
  assert.deepEqual(runNames(source), [
    "signaling_loss_keeps_established_peer",
    "changed_offer_keeps_binding",
  ])
})
