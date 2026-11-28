import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readDesktopRoutes } from "./desktop-routes.ts"
import { sourceDshRuntime } from "./index.ts"

test("only an enabled registration imports declarative desktop model settings and its default", async t => {
  const home = await mkdtemp(join(tmpdir(), "deskfleet-desktop-routes-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, "profiles", "desktop")
  const patch = join(directory, "cordis.patch.yml")
  await mkdir(directory, { recursive: true })
  const entry = sourceDshRuntime().entryPoint
  const env = { DSH_HOME: home }
  assert.deepEqual((await readDesktopRoutes(entry, env)).providers, {})
  const routes = `
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      saved: { displayName: Saved, apiKeyEnv: SERVICE_KEY }
      other: {}
      deepseek-account: {}
      deepseek-official: {}
      expression: { baseURL: !!js "process.exit(99)" }
- id: agent-default-model
  config: { provider: saved, model: shared-name }
- id: permission
  config: !!js "process.exit(99)"
`
  await writeFile(patch, routes)
  const expected = {
    home, providers: { saved: { displayName: "Saved", apiKeyEnv: "SERVICE_KEY" }, other: {} },
    preferred: { provider: "saved", model: "shared-name" },
  }
  assert.deepEqual(await readDesktopRoutes(entry, { ...env, DESKFLEET_DSH_DESKTOP_ROUTES: "0" }), { home: "", providers: {} })
  assert.deepEqual(await readDesktopRoutes(entry, env), expected)
  assert.deepEqual(await readDesktopRoutes(entry, { ...env, DESKFLEET_DSH_DESKTOP_ROUTES: "1" }), expected)

  // Match upstream patch precedence. A name mismatch leaves the earlier config intact.
  await writeFile(patch, routes + '\n- id: llm-pi-ai\n  name: unrelated-plugin\n  disabled: true\n')
  assert.deepEqual(await readDesktopRoutes(entry, env), expected)
  await writeFile(patch, routes + "\n- id: llm-pi-ai\n  disabled: true\n")
  assert.deepEqual(await readDesktopRoutes(entry, env), { home, providers: {} })
  await writeFile(patch, routes + "\n- id: llm-pi-ai\n  config: {providers: {other: {}}}\n")
  assert.deepEqual(await readDesktopRoutes(entry, env), { home, providers: { other: {} } })

  const global = join(home, "cordis.patch.yml")
  await writeFile(global, routes)
  assert.deepEqual(await readDesktopRoutes(entry, env), expected)
  await writeFile(global, "- id: llm-pi-ai\n  disabled: true\n")
  assert.deepEqual(await readDesktopRoutes(entry, env), { home, providers: {} })
})
