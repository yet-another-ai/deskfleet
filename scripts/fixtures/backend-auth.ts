import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

export interface FixtureIdentity { subject: string; name: string; email: string }
export interface FixtureLogin { token: string; user: { id: string; name: string; email: string }; expiresAt: string }

/** Uses the shipped registration, local verification mail, password and native exchange APIs. */
export function createAuthFixture(mailDirectory: string, origin: string) {
  const suffix = randomUUID()
  const identities = new Map<string, { email: string; password: string; registered: boolean }>()
  const exchanges: string[] = []
  function credentials(identity: FixtureIdentity) {
    let value = identities.get(identity.subject)
    if (!value) {
      const [local, domain] = identity.email.split("@")
      value = { email: `${local}+${suffix}@${domain}`, password: `Fixture password ${randomUUID()}`, registered: false }
      identities.set(identity.subject, value)
    }
    return value
  }
  return {
    exchanges, credentials,
    async login(backend: string, identity: FixtureIdentity): Promise<FixtureLogin> {
      const account = credentials(identity)
      const cookies = new Map<string, string>()
      let csrf = ""
      async function request(path: string, body?: unknown, browser = true) {
        const response = await fetch(`${backend}/api${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json", ...(browser ? { origin, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), "x-csrf-token": csrf } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";", 1)[0]!
          const separator = pair.indexOf("=")
          cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
        }
        assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
        const value = await response.json() as Record<string, unknown>
        if (typeof value.csrfToken === "string") csrf = value.csrfToken
        return value
      }
      await request("/auth/config")
      if (!account.registered) {
        await request("/auth/register", { email: account.email })
        const messages = await Promise.all((await readdir(mailDirectory)).map(file => readFile(join(mailDirectory, file), "utf8")))
        const mail = messages.find(message => message.includes(account.email))
        assert.ok(mail, "Registration must deliver a verification message")
        const decoded = mail.replace(/=\r?\n/gu, "").replace(/=([A-F\d]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        const token = decoded.split("#token=")[1]?.split(/\s/u)[0]
        assert.ok(token, "Verification mail must contain a one-use link")
        await request("/auth/verify", { token, name: identity.name, password: account.password })
        account.registered = true
      } else {
        await request("/auth/login", { email: account.email, password: account.password })
      }
      const started = await request("/auth/start", { returnTo: "http://127.0.0.1:49152/auth/callback" }, false)
      const attempt = new URL(String(started.authorizationUrl)).searchParams.get("attempt")
      assert.ok(attempt)
      const completed = await request("/auth/desktop/complete", { attempt })
      const code = new URLSearchParams(new URL(String(completed.returnTo)).hash.slice(1)).get("loginCode")
      assert.ok(code)
      const exchanged = await request("/auth/exchange", { code, loginVerifier: started.loginVerifier }, false)
      exchanges.push(identity.subject)
      return exchanged as unknown as FixtureLogin
    },
  }
}
