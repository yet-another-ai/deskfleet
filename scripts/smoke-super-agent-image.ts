import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cleanup, docker, printLogs, publishedPort, ready, startPostgres } from "./fixtures/image-smoke.ts"

const [image, profile, ...extra] = process.argv.slice(2)
if (!image || (profile !== undefined && profile !== "--release") || extra.length) {
  throw new Error("Usage: node scripts/smoke-super-agent-image.ts <image> [--release]")
}

const network = `deskfleet-eve-smoke-${randomUUID()}`
const database = `${network}-postgres`
const bootstrap = `${network}-bootstrap`
const agent = `${network}-agent`
const world = "WORKFLOW_POSTGRES_URL=postgres://postgres:smoke-test@postgres:5432/deskfleet"

try {
  docker("network", "create", network)
  await startPostgres(network, database, true)
  docker("run", "--name", bootstrap, "--network", network, "--env", world, image, "bootstrap")
  docker("run", "--detach", "--name", agent, "--network", network, "--publish", "127.0.0.1::3100",
    "--env", world, "--env", "DESKFLEET_SUPER_AGENT_SECRET=fixture-secret", image)
  const address = `127.0.0.1:${publishedPort(agent, 3100)}`
  const origin = `http://${address}`
  await ready("the Eve HTTP listener", async () => {
    assert.equal(docker("inspect", "--format", "{{.State.Running}}", agent), "true", "Eve exited during startup")
    try {
      const response = await fetch(`${origin}/eve/v1/health`, { signal: AbortSignal.timeout(2_000) })
      return response.ok
    } catch {
      return false
    }
  })
  assert.notEqual(docker("exec", agent, "id", "-u"), "0", "Eve must run as an unprivileged user")
  const unauthorized = await fetch(`${origin}/eve/v1/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: randomUUID() }),
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(unauthorized.status, 401, "An unauthenticated request must not create a Session")

  // This Actix fixture uses a local Statsig gate and the image's real Eve endpoint.
  const output = execFileSync("cargo", [
    "test", "--locked", ...(profile ? [profile] : []), "-p", "deskfleet-server", "--lib",
    "cloud_agent::tests::image::create_empty_session", "--", "--ignored", "--exact",
  ], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env, DESKFLEET_TEST_EVE_ADDRESS: address,
      TEST_DATABASE_URL: `postgres://postgres:smoke-test@127.0.0.1:${publishedPort(database, 5432)}/deskfleet`,
    },
  })
  process.stdout.write(output)
  assert.match(output, /test result: ok\. 1 passed;/u, "The Rust/Eve image integration test must run")
  console.log("Super Agent image passed PostgreSQL bootstrap, service authentication and DeskFleet Session creation")
} catch (error) {
  printLogs(bootstrap, agent, database)
  throw error
} finally {
  cleanup(network, agent, bootstrap, database)
}
