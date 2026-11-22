import { createHash, timingSafeEqual } from "node:crypto"
import type { AuthFn } from "eve/channels/auth"
import { defaultEveAuth, eveChannel } from "eve/channels/eve"

const deskfleet: AuthFn<Request> = request => {
  const secret = process.env.DESKFLEET_SUPER_AGENT_SECRET
  const authorization = request.headers.get("authorization")
  if (!secret || !authorization) return null

  const digest = (value: string) => createHash("sha256").update(value).digest()
  if (!timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`))) return null

  return { authenticator: "deskfleet", principalId: "deskfleet-server", principalType: "service", attributes: {} }
}

function readSender(request: Request): { id: string; name: string } | undefined {
  const encoded = request.headers.get("x-deskfleet-message-sender")
  if (!encoded) return undefined

  let sender: unknown
  try {
    sender = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  if (!sender || typeof sender !== "object" || !("id" in sender) || !("name" in sender)) return undefined
  if (typeof sender.id !== "string" || !sender.id.trim() || typeof sender.name !== "string") return undefined
  return { id: sender.id, name: sender.name }
}

export default eveChannel({
  auth: [deskfleet],
  onMessage(ctx) {
    // Eve runs onMessage after authenticating the DeskFleet gateway.
    const sender = readSender(ctx.eve.request)
    if (!sender) return { auth: defaultEveAuth(ctx) }
    const headers = ctx.eve.request.headers
    const teamId = headers.get("x-deskfleet-team-id")
    const loginId = headers.get("x-deskfleet-login-id")
    const sessionId = headers.get("x-deskfleet-session-id")
    const attributes: Record<string, string> = teamId && loginId && sessionId ? { teamId, loginId, sessionId } : {}
    return {
      auth: { authenticator: "deskfleet", principalId: sender.id, principalType: "user", attributes },
      context: [`DeskFleet message sender: ${JSON.stringify(sender)}`],
    }
  },
})
