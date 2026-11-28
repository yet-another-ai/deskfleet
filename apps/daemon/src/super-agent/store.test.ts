import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openCatalog } from "@deskfleet/native"
import { LocalSuperStore } from "./store.ts"
import { superWorkspaces } from "./workspaces.ts"
import { DaemonCatalog } from "../machine/catalog.ts"

test("front desk edits are durable, serialized and isolated per user; stale writers fail", async t => {
  const root = await mkdtemp(join(tmpdir(), "deskfleet-front-state-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const open = () => openCatalog(join(root, "old.sqlite"), "machine")
  const db = await open()
  const store = new LocalSuperStore<string[]>(db)
  const stale = new LocalSuperStore<string[]>(db)
  await store.init()
  await store.update("one", () => [], rows => rows.push("first"))
  await stale.init()
  await Promise.all(["a", "b"].map(id => store.update("one", () => [], rows => rows.push(id))))
  await assert.rejects(stale.update("one", () => [], rows => rows.push("stale")), /changed during write/)
  await assert.rejects(store.update("one", () => [], rows => { rows.length = 0; throw Error("interrupted") }))
  await store.update("two", () => [], rows => rows.push("private"))
  store.get("one")!.push("outside")
  await db.close()
  const reopened = await open()
  try {
    const loaded = new LocalSuperStore<string[]>(reopened)
    await loaded.init()
    assert.deepEqual(loaded.get("one"), ["first", "a", "b"])
    assert.deepEqual(loaded.get("two"), ["private"])
  } finally { await reopened.close() }
})

test("default worker directory is created once per user and excluded from cross-project evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "deskfleet-front-workspace-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = new DaemonCatalog(root)
  await catalog.init()
  try {
    const { workspaces, ensureDefaultWorkspace } = superWorkspaces(catalog, root)
    assert.deepEqual(await workspaces("one"), [])
    const [first, duplicate, second] = await Promise.all(["one", "one", "two"].map(ensureDefaultWorkspace))
    assert.equal(first, duplicate)
    assert.notEqual(first, second)
    assert.deepEqual(await workspaces("one"), [])
    assert.deepEqual((await workspaces("one", true)).map(x => x.id), [first])
    assert.deepEqual((await workspaces("two", true)).map(x => x.id), [second])
  } finally { await catalog.close() }
})
