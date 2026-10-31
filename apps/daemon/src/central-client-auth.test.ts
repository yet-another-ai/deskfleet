import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { CentralClient } from "./central-client.ts"
import type { ControlPeers } from "./control-server.ts"
import type { MachineOperations } from "./machine-operations.ts"

interface Rejection {
  name: string
  status: number
  contentType?: string
  body: string
  revoked?: boolean
  quotaMessage?: string
}

const credentialError = JSON.stringify({ error: { code: "machine_credential_rejected", message: "Machine credential rejected" } })
const responses: Rejection[] = [
  { name: "generic JSON unauthorized", status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthorized", message: "Sign in required" } }), quotaMessage: "Sign in required" },
  { name: "JSON forbidden", status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "Team limit reached" } }), quotaMessage: "Team limit reached" },
  { name: "HTML unauthorized", status: 401, contentType: "text/html", body: "<html>Proxy authentication required</html>" },
  { name: "HTML forbidden", status: 403, contentType: "text/html", body: "<html>Blocked by proxy</html>" },
  { name: "malformed JSON", status: 401, contentType: "application/json", body: "{" },
  { name: "missing error code", status: 401, contentType: "application/json", body: "{}" },
  { name: "null JSON", status: 401, contentType: "application/json", body: "null" },
  { name: "credential code at wrong status", status: 403, contentType: "application/json", body: credentialError, quotaMessage: "Machine credential rejected" },
  { name: "credential code without JSON content type", status: 401, body: credentialError, quotaMessage: "Machine credential rejected" },
  { name: "credential code with text content type", status: 401, contentType: "text/plain", body: credentialError, quotaMessage: "Machine credential rejected" },
  { name: "explicit machine credential rejection", status: 401, contentType: "application/json; charset=utf-8", body: credentialError, quotaMessage: "Machine credential rejected", revoked: true },
]

async function setup(context: TestContext, rejection: Rejection) {
  const directory = await mkdtemp(join(tmpdir(), "df-http-auth-"))
  const requests: string[] = []
  let denying = true
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer durable-machine-token")
    requests.push(request.url!)
    if (denying) {
      response.writeHead(rejection.status, rejection.contentType ? { "content-type": rejection.contentType } : {})
      response.end(rejection.body)
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ authorized: true, remaining: 10 }))
    }
  })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const credentials = {
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    serverId: "server", teamId: "team", machineId: "same-machine", token: "durable-machine-token",
  }
  const path = join(directory, "central.json")
  await writeFile(path, JSON.stringify(credentials))
  const unsubscribe = () => () => {}
  const operations = {
    agents: { journal: { identity: { originId: "same-origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
    providers: { metadata: () => ({}), onChanged: unsubscribe },
    terminals: { onChange: unsubscribe },
  } as unknown as MachineOperations
  const clients: CentralClient[] = []
  context.after(async () => {
    for (const client of clients) await client.close()
    await server[Symbol.asyncDispose]()
    await rm(directory, { recursive: true, force: true })
  })
  const open = async () => {
    const client = new CentralClient(directory, operations, {} as ControlPeers)
    clients.push(client)
    await client.init()
    return client
  }
  return {
    central: await open(), open, path, credentials, requests,
    recover() { denying = false },
  }
}

for (const operation of ["sync", "delegation", "quota"] as const) {
  test(`${operation} only retires a machine after an explicit credential rejection`, async context => {
    for (const response of responses) {
      await context.test(response.name, async context => {
        const fixture = await setup(context, response)
        const { central, path, credentials, requests } = fixture
        if (operation === "sync") {
          // Closing performs the real final catalog upload and waits for its response.
          await central.close()
          assert.deepEqual(requests, ["/api/daemon/catalog"])
        } else if (operation === "delegation") {
          await assert.rejects(central.authorizeDelegation({ kind: "user", userId: "user", deviceId: "device" }), new RegExp(`\\(${response.status}\\)`))
          assert.deepEqual(requests, ["/api/daemon/authorize-delegation"])
        } else {
          await assert.rejects(central.quotaRequest("GET", "/api/daemon/entitlements"), {
            message: response.quotaMessage ?? `Team allowance request failed (${response.status})`,
          })
          assert.deepEqual(requests, ["/api/daemon/entitlements"])
        }
        assert.equal(central.status().revoked, response.revoked === true)
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), response.revoked ? { ...credentials, revoked: true } : credentials)

        fixture.recover()
        await central.close()
        const beforeRestart = requests.length
        const restored = await fixture.open()
        assert.equal(restored.status().revoked, response.revoked === true)
        assert.equal(restored.status().machineId, "same-machine")
        assert.equal(restored.status().identity.originId, "same-origin")
        await restored.close()
        assert.equal(requests.length, beforeRestart + (response.revoked ? 0 : 1),
          "Recoverable denials must retry with the same machine after restart; rejected credentials must stay retired")
      })
    }
  })
}
