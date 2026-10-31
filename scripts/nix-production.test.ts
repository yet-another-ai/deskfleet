import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test, { type TestContext } from "node:test"
import { checkProductionConfiguration, productionConfiguration, publicVariables } from "./nix-production.ts"

const production = {
  VITE_DESKFLEET_SERVER_URL: "https://fleet.example.com",
  VITE_STATSIG_CLIENT_KEY: "client-public",
  VITE_STATSIG_ENVIRONMENT: "production",
  VITE_SENTRY_DSN: "https://public@sentry.example.com/123",
  VITE_SENTRY_ENVIRONMENT: "production",
}

function temporary(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-nix-production-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("configuration exports only public renderer inputs and keeps optional telemetry empty", () => {
  const configuration = productionConfiguration({
    VITE_DESKFLEET_SERVER_URL: " https://fleet.example.com \n",
    MAC_CSC_LINK: "private-signing-material",
    UNRELATED_VARIABLE: "not-a-client-input",
  })
  assert.deepEqual(configuration, {
    VITE_DESKFLEET_SERVER_URL: production.VITE_DESKFLEET_SERVER_URL,
    VITE_STATSIG_CLIENT_KEY: "",
    VITE_STATSIG_ENVIRONMENT: "",
    VITE_SENTRY_DSN: "",
    VITE_SENTRY_ENVIRONMENT: "",
  })
  for (const origin of [undefined, "", " \n"]) {
    assert.throws(() => productionConfiguration({ VITE_DESKFLEET_SERVER_URL: origin }), /Set VITE_DESKFLEET_SERVER_URL/)
  }
})

test("release validation rejects changed configuration and undeclared snapshot fields", context => {
  const filename = join(temporary(context), "production.json")
  writeFileSync(filename, JSON.stringify(production))
  assert.doesNotThrow(() => checkProductionConfiguration(filename, production))
  assert.throws(() => checkProductionConfiguration(filename, { ...production, VITE_STATSIG_CLIENT_KEY: "changed" }),
    /differs for VITE_STATSIG_CLIENT_KEY/)
  assert.throws(() => checkProductionConfiguration(filename, { VITE_DESKFLEET_SERVER_URL: production.VITE_DESKFLEET_SERVER_URL }),
    /differs for VITE_STATSIG_CLIENT_KEY, VITE_STATSIG_ENVIRONMENT, VITE_SENTRY_DSN, VITE_SENTRY_ENVIRONMENT/)
  for (const value of [null, [], { ...production, PRIVATE_KEY: "private" }, { ...production, VITE_SENTRY_DSN: null }]) {
    writeFileSync(filename, JSON.stringify(value))
    assert.throws(() => checkProductionConfiguration(filename, production), /exactly the five public renderer variables/)
  }
})

test("sync consumes paginated GitHub environment variables without exporting other values", { skip: process.platform === "win32" }, context => {
  const directory = temporary(context)
  const destination = join(directory, "nix", "production.json")
  const fixture = join(directory, "gh.mjs")
  const variables = Object.entries(production).map(([name, value]) => ({ name, value }))
  const pages = [{ variables: variables.slice(0, 2) }, { variables: [
    ...variables.slice(2), { name: "UNRELATED_VARIABLE", value: "unrelated" },
  ] }]
  writeFileSync(fixture, `import assert from "node:assert/strict"
assert.deepEqual(process.argv.slice(2), ["api", "repos/yet-another-ai/deskfleet/environments/production/variables", "--paginate", "--slurp"])
console.log(${JSON.stringify(JSON.stringify(pages))})
`)
  writeFileSync(join(directory, "gh"), '#!/bin/sh\nexec "$DESKFLEET_TEST_NODE" "$DESKFLEET_GH_FIXTURE" "$@"\n', { mode: 0o755 })
  const path = Object.entries(process.env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? ""
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"))
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "nix-production.ts"), "sync", destination], {
    encoding: "utf8", env: { ...env, PATH: `${directory}${delimiter}${path}`, DESKFLEET_TEST_NODE: process.execPath, DESKFLEET_GH_FIXTURE: fixture },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), production)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(destination, "utf8"))), [...publicVariables])
  assert.doesNotMatch(result.stdout, /client-public|unrelated/)
})
