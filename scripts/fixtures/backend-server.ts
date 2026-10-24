import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer, type AddressInfo } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startOidcFixture } from "./backend-oidc.ts"
import { until } from "./backend-peer.ts"

/** Starts the shipped server binary against the supplied test database, without resetting it. */
export async function startBackendFixture(options: { databaseUrl?: string; binary?: string; returnTo?: string[]; allowedOrigins?: string[] } = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.TEST_DATABASE_URL
  assert.ok(databaseUrl, "Set TEST_DATABASE_URL to an isolated PostgreSQL test database")
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const binary = options.binary ?? process.env.DESKFLEET_SERVER_BINARY ?? join(root, "target/debug", process.platform === "win32" ? "deskfleet-server.exe" : "deskfleet-server")
  const probe = createServer().listen(0, "127.0.0.1")
  await once(probe, "listening")
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  const backend = `http://127.0.0.1:${port}`
  const oidc = await startOidcFixture("deskfleet-test", `${backend}/api/auth/callback`)
  const server = spawn(binary, [], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, DATABASE_URL: databaseUrl, DESKFLEET_BIND_ADDR: `127.0.0.1:${port}`, DESKFLEET_PUBLIC_URL: backend,
      DESKFLEET_OIDC_ISSUER: oidc.issuer, DESKFLEET_OIDC_CLIENT_ID: "deskfleet-test", DESKFLEET_OIDC_CLIENT_SECRET: undefined,
      DESKFLEET_OIDC_RETURN_TO: (options.returnTo ?? ["http://127.0.0.1:*/auth/callback"]).join(","),
      DESKFLEET_WEB_ORIGINS: (options.allowedOrigins ?? []).join(","), RUST_LOG: "warn",
    },
  })
  let diagnostics = ""
  server.stdout.setEncoding("utf8").on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16_000) })
  server.stderr.setEncoding("utf8").on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16_000) })
  const exited = once(server, "close")
  void exited.catch(() => {})
  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM")
      const force = setTimeout(() => server.kill("SIGKILL"), 5_000)
      await exited.catch(() => {})
      clearTimeout(force)
    }
    await oidc.close()
  }
  try {
    await until(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Server exited before readiness: ${diagnostics}`)
      return fetch(`${backend}/healthz`).then(response => response.ok, () => false)
    }, Boolean, "PostgreSQL API readiness", 30_000)
  } catch (error) { await close(); throw error }
  return { backend, oidc, close, diagnostics: () => diagnostics }
}
