import assert from "node:assert/strict"
import test from "node:test"
import { invariantNames, quintFiles, runNames } from "./check-specs.ts"

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

test("spec check includes every invariant but not helpers, actions, or commented predicates", () => {
  const source = `
    val inv_ready: bool = clientReady
    val inv_original_error = returnedError == primaryError
    val inv_multiline: bool =
      grantRevoked
    val ready = true
    action inv_action = init
    // val inv_disabled: bool = false
    run recovery = init
  `
  assert.deepEqual(invariantNames(source), ["inv_ready", "inv_original_error", "inv_multiline"])
  assert.deepEqual(invariantNames("val helper = true"), [])
})
