import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"

const image = process.argv[2]
if (!image) throw new Error("Usage: node scripts/smoke-server-image.ts <image>")

const prefix = `deskfleet-image-smoke-${randomUUID()}`
const database = `${prefix}-postgres`
const server = `${prefix}-server`
const postgresImage = "postgres:18.6@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6"

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", timeout: 120_000 }).trim()
}

async function ready(description: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await check()) return
    await setTimeout(500)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

try {
  docker("network", "create", prefix)
  docker("run", "--detach", "--name", database, "--network", prefix,
    "--network-alias", "postgres", "--env", "POSTGRES_PASSWORD=smoke-test",
    "--env", "POSTGRES_DB=deskfleet", "--tmpfs", "/var/lib/postgresql", postgresImage)
  await ready("PostgreSQL", () => {
    try {
      docker("exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "deskfleet")
      return true
    } catch {
      return false
    }
  })

  docker("run", "--detach", "--name", server, "--network", prefix,
    "--publish", "127.0.0.1::8080", "--env",
    "DATABASE_URL=postgres://postgres:smoke-test@postgres:5432/deskfleet", image)
  const port = docker("inspect", "--format", '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}', server)
  assert.equal(docker("inspect", "--format", "{{.Config.User}}", server), "10001:10001")
  await ready("the container HTTP listener", async () => {
    assert.equal(docker("inspect", "--format", "{{.State.Running}}", server), "true",
      "Server exited before becoming ready")
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) return false
      const health = await response.json() as { status: string; protocol_version: number }
      assert.equal(health.status, "ok")
      assert.equal(health.protocol_version, 1)
      return true
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error
      return false
    }
  })
  docker("stop", "--time", "15", server)
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", server), "0",
    "Server did not shut down gracefully")
  console.log("Server image: non-root startup, PostgreSQL migrations, HTTP health, and shutdown passed")
} catch (error) {
  for (const container of [server, database]) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 10_000 })
    if (logs.status === 0) console.error(logs.stdout, logs.stderr)
  }
  throw error
} finally {
  for (const args of [["rm", "--force", server, database], ["network", "rm", prefix]]) {
    try { docker(...args) } catch { /* Clean up resources that were created before a failure. */ }
  }
}
