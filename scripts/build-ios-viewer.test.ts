import assert from "node:assert/strict"
import test from "node:test"
import { ALL_IOS_VIEWER_TARGETS, iosViewerTargets } from "./build-ios-viewer.ts"

test("iosViewerTargets defaults to both device and simulator slices", () => {
  assert.deepEqual(iosViewerTargets({}, []), ALL_IOS_VIEWER_TARGETS)
  assert.deepEqual(iosViewerTargets({ DESKFLEET_IOS_TARGETS: "   " }, []), ALL_IOS_VIEWER_TARGETS)
})

test("iosViewerTargets selects single slices from env or CLI flags and deduplicates", () => {
  assert.deepEqual(
    iosViewerTargets({ DESKFLEET_IOS_TARGETS: "aarch64-apple-ios" }, []),
    ["aarch64-apple-ios"],
  )
  assert.deepEqual(
    iosViewerTargets({ DESKFLEET_IOS_TARGETS: "aarch64-apple-ios-sim, aarch64-apple-ios-sim" }, []),
    ["aarch64-apple-ios-sim"],
  )
  assert.deepEqual(
    iosViewerTargets({ DESKFLEET_IOS_TARGETS: "aarch64-apple-ios" }, ["--target", "aarch64-apple-ios-sim"]),
    ["aarch64-apple-ios-sim"],
  )
  assert.deepEqual(
    iosViewerTargets({}, ["--target=aarch64-apple-ios,aarch64-apple-ios-sim"]),
    ALL_IOS_VIEWER_TARGETS,
  )
})

test("iosViewerTargets rejects unsupported or empty targets", () => {
  assert.throws(() => iosViewerTargets({ DESKFLEET_IOS_TARGETS: "x86_64-apple-ios" }, []), /Unsupported iOS viewer target/)
  assert.throws(() => iosViewerTargets({ DESKFLEET_IOS_TARGETS: "," }, []), /Select at least one/)
  assert.throws(() => iosViewerTargets({}, ["--target"]), /requires an iOS Rust target triple/)
})
