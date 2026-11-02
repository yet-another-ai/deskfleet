import type { CentralApi } from "./central.ts"
import type { McpServerConfig, McpServerInput, McpServerSnapshot } from "../../../apps/daemon/src/mcp-server-protocol.ts"

export type { McpServerConfig, McpServerInput, McpServerSnapshot } from "../../../apps/daemon/src/mcp-server-protocol.ts"

/** Private machine settings are read through authenticated management, never the catalog. */
export function mcpServersClient(central: Pick<CentralApi, "rpc">, teamId: string, machineId: string) {
  return {
    list: () => central.rpc<McpServerSnapshot>(teamId, machineId, "mcpServerList", {}),
    create: (server: McpServerInput) => central.rpc<McpServerConfig>(teamId, machineId, "mcpServerCreate", { server }),
    update: (serverId: string, changes: McpServerInput) => central.rpc<McpServerConfig>(teamId, machineId, "mcpServerUpdate", { serverId, changes }),
    remove: (serverId: string) => central.rpc<null>(teamId, machineId, "mcpServerRemove", { serverId }),
  }
}
