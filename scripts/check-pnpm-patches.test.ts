import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  checkPnpmPatches,
  parsePatchKey,
  selectorSurvivesVersionBump,
} from "./check-pnpm-patches.ts"

test("parsePatchKey distinguishes exact, range, and name-only selectors", () => {
  assert.deepEqual(parsePatchKey("@scope/pkg@1.2.3"), {
    kind: "exact",
    name: "@scope/pkg",
    version: "1.2.3",
  })
  assert.deepEqual(parsePatchKey("@scope/pkg@*"), {
    kind: "range",
    name: "@scope/pkg",
    range: "*",
  })
  assert.deepEqual(parsePatchKey("@scope/pkg@^1.2.3"), {
    kind: "range",
    name: "@scope/pkg",
    range: "^1.2.3",
  })
  assert.deepEqual(parsePatchKey("@scope/pkg"), { kind: "name", name: "@scope/pkg" })
  assert.deepEqual(parsePatchKey("pi-acp@0.0.34"), {
    kind: "exact",
    name: "pi-acp",
    version: "0.0.34",
  })
  assert.deepEqual(parsePatchKey("stream-markdown-parser@*"), {
    kind: "range",
    name: "stream-markdown-parser",
    range: "*",
  })
  assert.equal(selectorSurvivesVersionBump(parsePatchKey("@scope/pkg@1.2.3")), false)
  assert.equal(selectorSurvivesVersionBump(parsePatchKey("@scope/pkg@*")), true)
  assert.equal(selectorSurvivesVersionBump(parsePatchKey("@scope/pkg")), true)
})

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "deskfleet-pnpm-patches-"))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(dir, relative)
    mkdirSync(join(absolute, ".."), { recursive: true })
    writeFileSync(absolute, content)
  }
  return dir
}

const renovateExactDisabled = JSON.stringify({
  packageRules: [{
    matchManagers: ["npm"],
    matchPackageNames: ["left-pad"],
    enabled: false,
  }],
}, null, 2)

test("exact pins that Renovate can bump fail the contract with a fixable path", () => {
  const dir = fixture({
    "pnpm-workspace.yaml": `packages:\n  - apps/demo\npatchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n`,
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\npatchedDependencies:\n  left-pad@1.3.0: deadbeef\npackages:\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}\n`,
    "renovate.json": JSON.stringify({ packageRules: [] }),
    "package.json": "{}",
    "apps/demo/package.json": JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
    "patches/left-pad.patch": "diff --git a/index.js b/index.js\n",
  })
  const report = checkPnpmPatches(dir)
  assert.equal(report.ok, false)
  assert.match(report.errors.join("\n"), /must be Renovate-disabled|retarget the key to left-pad@\*/)
})

test("carry-across @* selectors stay valid when the resolved version moves", () => {
  const dir = fixture({
    "pnpm-workspace.yaml": `packages:\n  - apps/demo\npatchedDependencies:\n  'left-pad@*': patches/left-pad.patch\n`,
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\npatchedDependencies:\n  'left-pad@*': deadbeef\npackages:\n  left-pad@1.3.1:\n    resolution: {integrity: sha512-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}\n`,
    "renovate.json": JSON.stringify({ packageRules: [] }),
    "package.json": "{}",
    "apps/demo/package.json": JSON.stringify({ dependencies: { "left-pad": "1.3.1" } }),
    "patches/left-pad.patch": "diff --git a/index.js b/index.js\n",
  })
  const report = checkPnpmPatches(dir)
  assert.equal(report.ok, true, report.errors.join("\n"))
  assert.equal(report.entries[0]?.selector.kind, "range")
})

test("exact pins are allowed when Renovate npm updates are disabled", () => {
  const dir = fixture({
    "pnpm-workspace.yaml": `packages:\n  - apps/demo\npatchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n`,
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\npatchedDependencies:\n  left-pad@1.3.0: deadbeef\npackages:\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd}\n`,
    "renovate.json": renovateExactDisabled,
    "package.json": "{}",
    "apps/demo/package.json": JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
    "patches/left-pad.patch": "diff --git a/index.js b/index.js\n",
  })
  const report = checkPnpmPatches(dir)
  assert.equal(report.ok, true, report.errors.join("\n"))
})

test("unused exact patch after a version bump is reported clearly", () => {
  const dir = fixture({
    "pnpm-workspace.yaml": `packages:\n  - apps/demo\npatchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n`,
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\npatchedDependencies:\n  left-pad@1.3.0: deadbeef\npackages:\n  left-pad@1.4.0:\n    resolution: {integrity: sha512-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee}\n`,
    "renovate.json": renovateExactDisabled,
    "package.json": "{}",
    "apps/demo/package.json": JSON.stringify({ dependencies: { "left-pad": "1.4.0" } }),
    "patches/left-pad.patch": "diff --git a/index.js b/index.js\n",
  })
  const report = checkPnpmPatches(dir)
  assert.equal(report.ok, false)
  assert.match(report.errors.join("\n"), /unused|does not match declared/)
})

test("lockfile version scan ignores patchedDependencies keys", () => {
  // Manifest still pins 1.3.0, and the leftover exact patch key remains in
  // patchedDependencies, but packages: only resolves 1.4.0. Scanning the patch
  // key as a version would hide this unused-pin case.
  const dir = fixture({
    "pnpm-workspace.yaml": `packages:\n  - apps/demo\npatchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n`,
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\npatchedDependencies:\n  left-pad@1.3.0: deadbeef\npackages:\n  left-pad@1.4.0:\n    resolution: {integrity: sha512-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff}\n`,
    "renovate.json": renovateExactDisabled,
    "package.json": "{}",
    "apps/demo/package.json": JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
    "patches/left-pad.patch": "diff --git a/index.js b/index.js\n",
  })
  const report = checkPnpmPatches(dir)
  assert.equal(report.ok, false)
  assert.match(report.errors.join("\n"), /exact patch left-pad@1\.3\.0 is unused/)
})

test("repository patchedDependencies satisfy the Renovate patch contract", () => {
  const report = checkPnpmPatches()
  assert.equal(report.ok, true, report.errors.join("\n"))
  assert.ok(report.entries.some(entry =>
    entry.selector.name === "@agentclientprotocol/claude-agent-acp" &&
    selectorSurvivesVersionBump(entry.selector),
  ), "claude-agent-acp must carry across Renovate version bumps")
  assert.ok(report.entries.some(entry =>
    entry.selector.name === "stream-markdown-parser" &&
    selectorSurvivesVersionBump(entry.selector),
  ), "stream-markdown-parser must carry across Renovate version bumps")
  assert.ok(report.entries.some(entry =>
    entry.selector.name === "@agentclientprotocol/codex-acp" &&
    entry.selector.kind === "exact",
  ), "codex-acp stays exact/manual")
  assert.ok(report.entries.some(entry =>
    entry.selector.name === "pi-acp" &&
    entry.selector.kind === "exact",
  ), "pi-acp stays exact/manual")
})
