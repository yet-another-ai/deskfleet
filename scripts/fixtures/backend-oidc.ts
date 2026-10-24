import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface FixtureIdentity { subject: string; name: string; email: string }
export interface FixtureLogin { token: string; user: { id: string; name: string; email: string }; expiresAt: string }

/** A real, isolated OIDC issuer: the application still verifies discovery, PKCE, nonce and RS256. */
export async function startOidcFixture(clientId: string, redirectUri: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const key = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", use: "sig", alg: "RS256" }
  const codes = new Map<string, { challenge: string; nonce: string; identity: FixtureIdentity }>()
  const identities = new Map<string, FixtureIdentity>()
  let browserIdentity: FixtureIdentity | undefined
  const exchanges: string[] = []
  let issuer = ""
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify(value))
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, issuer)
      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return json(response, {
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
        })
      }
      if (request.method === "GET" && url.pathname === "/jwks") return json(response, { keys: [key] })
      if (request.method === "GET" && url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("client_id"), clientId)
        assert.equal(url.searchParams.get("redirect_uri"), redirectUri)
        assert.equal(url.searchParams.get("response_type"), "code")
        assert.equal(url.searchParams.get("code_challenge_method"), "S256")
        const challenge = url.searchParams.get("code_challenge")!
        const nonce = url.searchParams.get("nonce")!
        assert.ok(challenge && nonce && url.searchParams.get("state"))
        const identity = identities.get(url.searchParams.get("fixtureIdentity")!) ?? browserIdentity
        assert.ok(identity, "The fixture must select an identity before authorization")
        const code = randomUUID()
        codes.set(code, { challenge, nonce, identity })
        const callback = new URL(redirectUri)
        callback.searchParams.set("code", code)
        callback.searchParams.set("state", url.searchParams.get("state")!)
        response.writeHead(302, { location: callback.href }); response.end(); return
      }
      if (request.method === "POST" && url.pathname === "/token") {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
        assert.equal(body.get("grant_type"), "authorization_code")
        assert.equal(body.get("client_id"), clientId)
        assert.equal(body.get("redirect_uri"), redirectUri)
        const code = body.get("code")!
        const pending = codes.get(code)
        assert.ok(pending, "Authorization codes are single use")
        codes.delete(code)
        assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), pending.challenge)
        const now = Math.floor(Date.now() / 1000)
        const payload = {
          iss: issuer, sub: pending.identity.subject, aud: clientId, exp: now + 300, iat: now, nonce: pending.nonce,
          name: pending.identity.name, email: pending.identity.email, email_verified: true,
        }
        const encoded = [ { alg: "RS256", kid: key.kid, typ: "JWT" }, payload ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".")
        const jwt = `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`
        exchanges.push(pending.identity.subject)
        return json(response, { access_token: randomUUID(), token_type: "Bearer", expires_in: 300, id_token: jwt })
      }
      json(response, { error: "not_found" }, 404)
    })().catch(error => json(response, { error: "invalid_request", error_description: String(error) }, 400))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    issuer, exchanges,
    useIdentity(identity: FixtureIdentity): void { browserIdentity = identity },
    async login(backend: string, identity: FixtureIdentity): Promise<FixtureLogin> {
      identities.set(identity.subject, identity)
      const started = await fetch(`${backend}/api/auth/start`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnTo: "http://127.0.0.1:49152/auth/callback" }),
      })
      assert.equal(started.status, 200, await started.clone().text())
      const { authorizationUrl, loginVerifier } = await started.json() as { authorizationUrl: string; loginVerifier: string }
      const authorize = new URL(authorizationUrl)
      authorize.searchParams.set("fixtureIdentity", identity.subject)
      const authorized = await fetch(authorize, { redirect: "manual" })
      assert.equal(authorized.status, 302, await authorized.clone().text())
      const callback = await fetch(authorized.headers.get("location")!, { redirect: "manual" })
      assert.equal(callback.status, 302, await callback.clone().text())
      const code = new URLSearchParams(new URL(callback.headers.get("location")!).hash.slice(1)).get("loginCode")
      assert.ok(code)
      const exchanged = await fetch(`${backend}/api/auth/exchange`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, loginVerifier }),
      })
      assert.equal(exchanged.status, 200, await exchanged.clone().text())
      return await exchanged.json() as FixtureLogin
    },
    close: () => server[Symbol.asyncDispose](),
  }
}
