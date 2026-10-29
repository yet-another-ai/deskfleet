import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"
import { build as buildWeb } from "vite"
import { startDaemon } from "../../daemon/src/daemon.ts"
import type { AgentSnapshot } from "../../daemon/src/agent-protocol.ts"
import { BackendAgent } from "../../../scripts/fixtures/backend-agent.ts"
import { startBackendFixture } from "../../../scripts/fixtures/backend-server.ts"
import { until } from "../../../scripts/fixtures/backend-peer.ts"
import type { BackendClientsContext } from "./fixtures/backend-clients-main.ts"

const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-clients-smoke-")))
const root = resolve(import.meta.dirname, "../../..")
const executable = createRequire(import.meta.url)("electron") as string
const execute = promisify(execFile)
const webDirectory = join(directory, "web")
const web = createServer((request, response) => {
  const path = new URL(request.url!, "http://fixture").pathname
  if (path.startsWith("/api/")) {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const upstream = await fetch(`${fixture.backend}${request.url}`, {
        method: request.method, headers: request.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      })
      const headers = Object.fromEntries(upstream.headers)
      response.writeHead(upstream.status, { ...headers, "set-cookie": upstream.headers.getSetCookie() })
      response.end(Buffer.from(await upstream.arrayBuffer()))
    })().catch(() => response.writeHead(502).end())
    return
  }
  const file = path === "/" || path.startsWith("/auth/") ? "/index.html" : path
  if (file.includes("..")) { response.writeHead(400).end(); return }
  void readFile(join(webDirectory, file)).then(bytes => {
    response.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" })
    response.end(bytes)
  }, () => response.writeHead(404).end())
}).listen(0, "127.0.0.1")
await once(web, "listening")
const webUrl = `http://localhost:${(web.address() as AddressInfo).port}/`
const fixture = await startBackendFixture({ returnTo: [webUrl, "http://127.0.0.1:*/auth/callback"], allowedOrigins: [webUrl.slice(0, -1)] })
const identity = { subject: `client-${randomUUID()}`, name: "Client smoke", email: "client@example.invalid" }
const login = await fixture.auth.login(fixture.backend, identity).catch(async error => {
  console.error(fixture.diagnostics())
  await fixture.close(); await web[Symbol.asyncDispose]()
  await rm(directory, { recursive: true, force: true })
  throw error
})
async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(`${fixture.backend}/api${path}`, { method, headers: { authorization: `Bearer ${login.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}
const rpc = <T>(machine: string, method: string, params: unknown) => request<T>(`/machines/${machine}/rpc`, { method, params })
const daemons: Awaited<ReturnType<typeof startDaemon>>[] = []
const providers: BackendAgent[] = []
const machines: string[] = []
const sessions: string[] = []
let teamId: string | undefined
let electron: ChildProcess | undefined
let diagnostics = ""
async function stopClient(): Promise<void> {
  if (!electron || electron.exitCode !== null || electron.signalCode !== null) return
  const exited = once(electron, "exit")
  if (electron.connected) electron.send({ close: true })
  const force = setTimeout(() => electron!.kill("SIGKILL"), 3_000)
  await exited; clearTimeout(force)
}
async function launch(mode: BackendClientsContext["mode"]): Promise<void> {
  const context: BackendClientsContext = {
    mode, backend: fixture.backend, webUrl, credentials: fixture.auth.credentials(identity), rendererDirectory: join(root, "apps/desktop/out/renderer"), preloadPath: join(root, "apps/desktop/out/preload/index.cjs"),
    daemonDirectory: join(directory, "daemon-0"), profileDirectory: join(directory, `profile-${mode}`), machines, sessionId: sessions[0]!, forceRelay: process.env.DESKFLEET_SMOKE_FORCE_RELAY === "1",
    teamId: teamId!, localProbePath: join(directory, "local-probe.js"),
  }
  await mkdir(context.profileDirectory, { recursive: true })
  await writeFile(join(context.profileDirectory, "settings.json"), JSON.stringify({ localAgentEnabled: false }))
  const env: NodeJS.ProcessEnv = { ...process.env, DESKFLEET_DAEMON_DIRECTORY: context.daemonDirectory }
  delete env.ELECTRON_RUN_AS_NODE
  electron = spawn(executable, [join(directory, "client.mjs"), `--backend-client-context=${JSON.stringify(context)}`], {
    cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  electron.stderr?.setEncoding("utf8").on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-20_000); process.stderr.write(chunk) })
  try {
    await new Promise<void>((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error(`${mode} client smoke timed out`)), 120_000)
      const fail = (error: unknown) => { clearTimeout(timer); reject(error) }
      electron!.once("error", fail)
      electron!.once("exit", code => fail(new Error(`${mode} client exited: ${code}`)))
      electron!.on("message", (message: { phase?: string; result?: unknown; error?: string }) => {
        if (message.error) fail(new Error(`${mode}: ${message.error}`))
        else if (message.phase === "online") {
          if (mode === "electron") console.log(`Electron local transport evidence: ${JSON.stringify(message.result)}`)
          void (async () => {
            const snapshot = await until(() => request<{ snapshot: AgentSnapshot }>(`/machines/${machines[0]}/sessions/${sessions[0]}`), value => value.snapshot.session.archiveState === "active" && value.snapshot.inputs.some(input => input.content.some(block => block.type === "text" && block.text === `Prompt from ${mode}`)), "central archive/restore synchronization")
            assert.equal(snapshot.snapshot.session.archiveState, "active")
            await daemons[0]!.close()
            electron!.send({ offline: true })
          })().catch(fail)
        } else if (message.result) { clearTimeout(timer); resolveResult() }
      })
    })
  } finally { await stopClient() }
}
try {
  // Both client bundles receive the fixture backend at compile time, as shipped clients do.
  const define = { "import.meta.env.VITE_DESKFLEET_SERVER_URL": JSON.stringify(fixture.backend) }
  await buildWeb({ root: join(root, "apps/web"), configFile: join(root, "apps/web/vite.config.ts"), define, build: { outDir: webDirectory, emptyOutDir: true } })
  await build({ entryPoints: [join(import.meta.dirname, "fixtures/backend-clients-main.ts")], outfile: join(directory, "client.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24", define })
  await build({ entryPoints: [join(import.meta.dirname, "fixtures/local-channels-renderer.ts")], outfile: join(directory, "local-probe.js"), bundle: true, platform: "browser", format: "iife", globalName: "localChannelSmoke", target: "chrome140" })
  const team = await request<{ id: string }>("/teams", { name: `Clients ${randomUUID()}` }); teamId = team.id
  for (let index = 0; index < 2; index++) {
    const repository = join(directory, `repo-${index}`); await mkdir(repository)
    await execute("git", ["init", repository]); await writeFile(join(repository, "README.md"), "client smoke\n")
    await execute("git", ["-C", repository, "add", "."])
    await execute("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
    const provider = new BackendAgent(); providers.push(provider)
    const daemon = await startDaemon(0, { controlDirectory: join(directory, `daemon-${index}`), agentProvider: provider, requestScreenCaptureAccess: async () => false, requestAccessibilityAccess: async () => false, requestFullDiskAccess: async () => null }); daemons.push(daemon)
    const { identity } = daemon.central.status()
    const enrollment = await request<{ machine: { id: string }; token: string }>(`/teams/${teamId}/machines`, { name: `Machine ${index}`, originId: identity.originId, localMachineId: identity.machineId })
    machines.push(enrollment.machine.id)
    await daemon.central.enroll({ serverUrl: fixture.backend, machineId: enrollment.machine.id, teamId, token: enrollment.token })
    await until(() => daemon.central.status(), status => status.connected, "daemon connection")
    const workspace = await rpc<{ id: string }>(machines[index]!, "workspaceCreate", { name: `Machine ${index}`, directories: [{ path: repository }] })
    const configured = await rpc<{ id: string }>(machines[index]!, "providerCreate", { provider: { template: "codex", name: "Fixture", env: {} } })
    const snapshot = await rpc<AgentSnapshot>(machines[index]!, "_deskfleet/session/create", { workspaceId: workspace.id, provider: configured.id, operationId: randomUUID(), context: "directory", title: `Machine ${index} conversation` })
    sessions.push(snapshot.session.id)
  }
  assert.equal(sessions[0], sessions[1])
  await launch("web")
  daemons[0] = await startDaemon(0, { controlDirectory: join(directory, "daemon-0"), agentProvider: providers[0]!, requestScreenCaptureAccess: async () => false, requestAccessibilityAccess: async () => false, requestFullDiskAccess: async () => null })
  await until(() => daemons[0]!.central.status(), status => status.connected, "daemon restart")
  await launch("electron")
  assert.deepEqual(providers[0]!.prompts, ["Prompt from web", "Prompt from electron"])
  console.log("Production Web and Electron: owned authentication, remote WebRTC, local Agent/Git/terminal with WebRTC disabled, Git invalidations, terminal replay, session reattachment, transport timing, archive/restore, equal-local-ID isolation and offline central history passed")
} catch (error) { console.error(diagnostics); console.error(fixture.diagnostics()); throw error }
finally {
  await stopClient(); await Promise.allSettled(daemons.map(daemon => daemon.close()))
  for (const machine of machines) await request(`/machines/${machine}`, undefined, "DELETE").catch(() => {})
  if (teamId) await request(`/teams/${teamId}`, undefined, "DELETE").catch(() => {})
  await fixture.close(); await web[Symbol.asyncDispose]()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
