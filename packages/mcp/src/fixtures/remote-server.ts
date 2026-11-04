import { writeFile } from "node:fs/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "remote-fixture", version: "1" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async request => ({
  tools: [{ name: request.params?.cursor ? "second" : "record", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
  ...request.params?.cursor ? {} : { nextCursor: "page-2" },
}))
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name === "fail") return { isError: true, content: [{ type: "text", text: "fixture tool failure" }] }
  await writeFile(process.env.DESKFLEET_TEST_OUTPUT!, JSON.stringify({ arguments: request.params.arguments, cwd: process.cwd() }))
  return { content: [{ type: "text", text: "recorded" }], structuredContent: { recorded: true } }
})
await server.connect(new StdioServerTransport())
