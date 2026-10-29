import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

const docsRoot = resolve(import.meta.dirname, "../docs")
const docsRequire = createRequire(resolve(docsRoot, "package.json"))

test("the website and embedded app share the router injection keys", async () => {
  // Keep VitePress's browser declarations out of the Node scripts typecheck.
  const { default: docsConfig } = await import(pathToFileURL(resolve(docsRoot, ".vitepress/config.ts")).href)
  const { resolveConfig } = await import(pathToFileURL(docsRequire.resolve("vite")).href)
  const config = await resolveConfig({ ...docsConfig.vite, root: docsRoot, configFile: false }, "build")
  const resolveImport = config.createResolver()
  const demoRouter = await resolveImport("vue-router", resolve(docsRoot, ".vitepress/theme/components/demos/product-demo-runtime.ts"))
  const appRouter = await resolveImport("vue-router", resolve(docsRoot, "../packages/components/src/App.vue"))

  assert.ok(demoRouter, "The embedded demo must resolve its router")
  assert.equal(appRouter, demoRouter, "createRouter and useRoute must resolve to the same module instance")
})
