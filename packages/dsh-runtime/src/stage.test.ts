import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pruneDshArtifacts } from "../stage.ts"

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

test("pruning removes development-only artifacts without touching runtime files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-dsh-prune-"))
  try {
    const pkg = join(directory, "node_modules", "@scope", "pkg")
    await mkdir(join(pkg, "lib"), { recursive: true })
    for (const name of ["index.js", "index.d.ts", "index.d.mts", "index.d.cts", "index.js.map", "native.pdb", "UPPER.MAP", "LICENSE.md"]) {
      await writeFile(join(pkg, name), name)
    }
    await writeFile(join(pkg, "lib", "nested.js"), "js")
    await writeFile(join(pkg, "lib", "nested.js.map"), "map")

    await pruneDshArtifacts(directory)

    for (const name of ["index.js", "LICENSE.md"]) {
      assert.equal(await exists(join(pkg, name)), true, name)
    }
    assert.equal(await exists(join(pkg, "lib", "nested.js")), true)
    for (const name of ["index.d.ts", "index.d.mts", "index.d.cts", "index.js.map", "native.pdb", "UPPER.MAP"]) {
      assert.equal(await exists(join(pkg, name)), false, name)
    }
    assert.equal(await exists(join(pkg, "lib", "nested.js.map")), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
