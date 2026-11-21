import { createHash, timingSafeEqual } from "node:crypto"
import type { AuthFn } from "eve/channels/auth"
import { eveChannel } from "eve/channels/eve"

const deskfleet: AuthFn<Request> = request => {
  const secret = process.env.DESKFLEET_SUPER_AGENT_SECRET
  const authorization = request.headers.get("authorization")
  if (!secret || !authorization) return null

  const digest = (value: string) => createHash("sha256").update(value).digest()
  if (!timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`))) return null

  return { authenticator: "deskfleet", principalId: "deskfleet-server", principalType: "service", attributes: {} }
}

export default eveChannel({ auth: [deskfleet] })
