import { execFileSync, spawnSync } from "node:child_process"
import { setTimeout } from "node:timers/promises"

const postgresImage = "postgres:18.6@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6"

export function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", timeout: 120_000 }).trim()
}

export async function ready(description: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await check()) return
    await setTimeout(500)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

export async function startPostgres(network: string, database: string, publish = false): Promise<void> {
  docker("run", "--detach", "--name", database, "--network", network, "--network-alias", "postgres",
    ...(publish ? ["--publish", "127.0.0.1::5432"] : []), "--env", "POSTGRES_PASSWORD=smoke-test",
    "--env", "POSTGRES_DB=deskfleet", "--tmpfs", "/var/lib/postgresql", postgresImage)
  await ready("PostgreSQL", () => {
    try {
      docker("exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "deskfleet")
      return true
    } catch {
      return false
    }
  })
}

export function publishedPort(container: string, port: number): string {
  return docker("inspect", "--format", `{{(index (index .NetworkSettings.Ports "${port}/tcp") 0).HostPort}}`, container)
}

export function printLogs(...containers: string[]): void {
  for (const container of containers) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 10_000 })
    if (logs.status === 0) console.error(logs.stdout, logs.stderr)
  }
}

export function cleanup(network: string, ...containers: string[]): void {
  for (const args of [["rm", "--force", ...containers], ["network", "rm", network]]) {
    try { docker(...args) } catch { /* Clean up resources that were created before a failure. */ }
  }
}
