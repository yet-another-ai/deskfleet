import { defineDynamic, defineMcpClientConnection } from "eve/connections"

export default defineDynamic(ctx => {
  const caller = ctx.session.auth.current
  if (caller?.principalType !== "user" || caller.attributes.sessionId !== ctx.session.id
    || !caller.attributes.teamId || !caller.attributes.loginId) return null

  const base = process.env.DESKFLEET_SUPER_AGENT_API_URL || "http://127.0.0.1:8080"
  const url = `${base.replace(/\/+$/, "")}/api/super-agent/mcp`
  return defineMcpClientConnection({
    url,
    instanceKey: url,
    description: "Discover this Team's machines, inspect their Workspaces and Agent providers, dispatch Sessions and use tools on consenting machines.",
    protocolVersionDiscovery: false,
    // Eve forwards the active turn's principal on each MCP request, even
    // when a shared conversation continues under another member's login.
    forwardPrincipal: true,
    auth: {
      principalType: "app",
      getToken: async () => {
        const token = process.env.DESKFLEET_SUPER_AGENT_SECRET
        if (!token) throw new Error("Set DESKFLEET_SUPER_AGENT_SECRET for DeskFleet machine access")
        return { token }
      },
    },
  })
})
