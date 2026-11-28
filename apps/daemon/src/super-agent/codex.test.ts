import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { listSuperCodexModels, supportsCodexCoordinatorVersion, superCodexArgs, superCodexImageArgs, superCodexSandboxArgs, writeSuperCodexCatalog } from "./codex.ts"
import { superModelBinary } from "./model.ts"

test("enables only exact Codex CLI versions verified for native tool-free coordination", () => {
  for (const version of ["codex-cli 0.170.0", "codex-cli 0.171.0"]) assert.equal(supportsCodexCoordinatorVersion(version), true)
  for (const version of ["codex-cli 0.172.0", "codex-cli 0.171.0-beta.1", "other 0.171.0"]) assert.equal(supportsCodexCoordinatorVersion(version), false)
})

test("verified Codex CLI sends native Responses requests without tools or inherited project instructions", async t => {
  if (process.platform !== "darwin") return t.skip("Codex coordinator is available on macOS")
  let binary: string
  try { binary = await superModelBinary("codex") } catch { return t.skip("Codex CLI is not installed") }
  const version = (await promisify(execFile)(binary, ["--version"])).stdout.trim()
  if (!supportsCodexCoordinatorVersion(version)) return t.skip("Coordinator rejects this CLI version")
  const cwd = await mkdtemp(join(tmpdir(), "deskfleet-codex-boundary-"))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const user = join(cwd, "user"), config = join(user, ".codex")
  const skill = join(config, "skills", "fixture")
  await mkdir(skill, { recursive: true })
  // An invented credential only for the loopback fixture, stored separately from the real user's login.
  await writeFile(join(config, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-fake-local-fixture" }))
  const marker = "PRIVATE_SYNTHETIC_PROJECT_OR_USER_INSTRUCTION"
  await Promise.all([writeFile(join(config, "AGENTS.md"), marker+"GLOBAL"), writeFile(join(cwd, "AGENTS.md"), marker+"PROJECT"),
    writeFile(join(cwd, "unrequested-note.txt"), marker+"FILE"),
    writeFile(join(skill, "SKILL.md"), `---\nname: fixture\ndescription: ${marker}SKILL\n---\n${marker}BODY`),
    writeFile(join(config, "config.toml"), `developer_instructions = "${marker}"\n[mcp_servers.not_permitted]\ncommand = "absent-fixture-command"\n`)])
  const schema = join(cwd, "schema.json"), instructions = join(cwd, "instructions.txt")
  await Promise.all([writeFile(schema, JSON.stringify({ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false })),
    writeFile(instructions, "Return the supplied synthetic value.")])
  const packets: Record<string, unknown>[] = []
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(426); res.end(); return } // ask the native provider to use its HTTP transport
    let body = ""
    for await (const chunk of req) body += chunk
    if (req.url === "/v1/responses") packets.push(JSON.parse(body))
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "Fixture request recorded", type: "invalid_request_error" } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const env = { PATH: process.env.PATH, HOME: user, USERPROFILE: user, CODEX_HOME: config, NO_PROXY: "127.0.0.1", SystemRoot: process.env.SystemRoot }
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGP4rxpCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAM6e4Eyl86E9AAAAAElFTkSuQmCC"
  const options = await listSuperCodexModels(binary, cwd, env)
  assert.ok(options.some(model => model.slug === "gpt-6.2-sol"))
  // Exercise every offered model with its highest supported coordinator effort.
  assert.ok(options.every(model => model.supported_reasoning_levels.every(level => level.effort !== "ultra")))
  for (const model of options) {
    const effort = model.supported_reasoning_levels.at(-1)!.effort
    const selection = {model: model.slug, reasoningEffort: effort}
    const catalog = await writeSuperCodexCatalog(binary, cwd, env, selection)
    const args = superCodexArgs(schema, instructions, join(cwd, "response.json"), catalog, selection)
    args.splice(args.indexOf("--output-schema"), 0, ...await superCodexImageArgs([{ type: "image", mimeType: "image/png", data: pixel }], cwd))
    args.splice(-1, 0, "-c", `openai_base_url="${origin}/v1"`, "-c", `chatgpt_base_url="${origin}"`)
    const child = execFile("/usr/bin/sandbox-exec", superCodexSandboxArgs(binary, args), { cwd, timeout: 15_000, killSignal: "SIGKILL", env })
    child.stdin?.end("SYNTHETIC_CURRENT_MESSAGE")
    await once(child, "exit")
    assert.ok(packets.length, model.slug + " emitted no request")
    for (const packet of packets.splice(0)) {
      assert.equal(packet.model, model.slug)
      assert.equal((packet.reasoning as { effort: string }).effort, effort)
      assert.deepEqual(packet.tools ?? [], [])
      assert.match(JSON.stringify(packet.input), /SYNTHETIC_CURRENT_MESSAGE/u)
      assert.match(JSON.stringify(packet.input), /"type":"input_image"/u)
      assert.match(JSON.stringify(packet), /Return the supplied synthetic value/u)
      const input = packet.input as Record<string, unknown>[]
      assert.ok(input.every(i=>i.type!=="additional_tools" && !i.tools), "Incremental tool declarations must be disabled")
      assert.ok(!JSON.stringify(packet).includes(marker), "Synthetic foreground input leaked project or user instructions")
    }
  }
})
