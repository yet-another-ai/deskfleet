import assert from "node:assert/strict"
import test from "node:test"
import { checkPackageBoundaries, importSpecifiers, type WorkspacePackage } from "./check-package-boundaries.ts"

const packages: WorkspacePackage[] = [
  { name: "@deskfleet/protocol", dir: "packages/protocol", dependencies: new Set(["zod"]) },
  { name: "@deskfleet/client", dir: "packages/client", dependencies: new Set(["@deskfleet/protocol"]) },
  { name: "@deskfleet/daemon", dir: "apps/daemon", dependencies: new Set(["@deskfleet/client", "@deskfleet/protocol"]) },
  { name: "@deskfleet/agent-core", dir: "packages/agents/core", dependencies: new Set() },
]

function check(path: string, content: string) {
  return checkPackageBoundaries(packages, [{ path, content }])
}

test("import specifiers include static, re-exported, dynamic, and side-effect imports", () => {
  assert.deepEqual(importSpecifiers([
    `import type { A } from "./a.ts"`,
    `export { b } from '@deskfleet/client/b'`,
    `const c = await import("./c.ts")`,
    `import "./d.css"`,
    `const text = "from ./not-an-import"`,
  ].join("\n")), ["./a.ts", "@deskfleet/client/b", "./c.ts", "./d.css"])
})

test("shipped source reaches other packages only through declared package exports", () => {
  assert.deepEqual(check("apps/daemon/src/machine/catalog.ts", `import { x } from "../../../../packages/client/src/x.ts"`), [
    "apps/daemon/src/machine/catalog.ts: import @deskfleet/client by its package name instead of ../../../../packages/client/src/x.ts",
  ])
  assert.deepEqual(check("packages/client/src/x.ts", `import { y } from "@deskfleet/daemon/y"`), [
    "packages/client/src/x.ts: @deskfleet/client must declare a dependency on @deskfleet/daemon",
  ])
  assert.deepEqual(check("apps/daemon/src/machine/catalog.ts", `import { x } from "@deskfleet/client/x"\nimport { y } from "./y.ts"`), [])
})

test("nested packages own their files instead of the enclosing directory", () => {
  assert.deepEqual(check("packages/agents/core/src/index.ts", `import { a } from "./a.ts"`), [])
  assert.deepEqual(check("packages/agents/core/src/index.ts", `import { p } from "../../../protocol/src/p.ts"`), [
    "packages/agents/core/src/index.ts: import @deskfleet/protocol by its package name instead of ../../../protocol/src/p.ts",
  ])
})

test("tests, fixtures, and tool configuration may use internals but still declare workspace dependencies", () => {
  assert.deepEqual(check("apps/daemon/src/machine/catalog.test.ts", `import { x } from "../../../../packages/client/src/x.ts"`), [])
  assert.deepEqual(check("apps/daemon/scripts/fixtures/peer.ts", `import { x } from "../../../../packages/client/src/x.ts"`), [])
  assert.deepEqual(check("apps/daemon/vite.main.config.ts", `import { x } from "../../packages/client/src/x.ts"`), [])
  assert.deepEqual(check("packages/client/src/x.test.ts", `import { y } from "@deskfleet/daemon/y"`), [
    "packages/client/src/x.test.ts: @deskfleet/client must declare a dependency on @deskfleet/daemon",
  ])
})

test("the protocol package stays a platform-neutral leaf", () => {
  assert.deepEqual(check("packages/protocol/src/files.ts", [
    `import { readFile } from "node:fs/promises"`,
    `import type { X } from "@deskfleet/client/x"`,
    `import { z } from "zod"`,
    `import type { Y } from "@deskfleet/protocol/y"`,
  ].join("\n")), [
    "packages/protocol/src/files.ts: @deskfleet/protocol is platform-neutral and cannot import node:fs/promises",
    "packages/protocol/src/files.ts: @deskfleet/protocol is a leaf package and cannot import @deskfleet/client",
  ])
  assert.deepEqual(check("packages/protocol/src/files.test.ts", `import test from "node:test"`), [])
})

test("files outside workspace packages and unknown scoped packages are ignored", () => {
  assert.deepEqual(check("scripts/smoke.ts", `import { x } from "../packages/client/src/x.ts"`), [])
  assert.deepEqual(check("packages/client/src/x.ts", `import { y } from "@deskfleet/unpublished"`), [])
})
