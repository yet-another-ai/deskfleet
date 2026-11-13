import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AppStoreConnect } from "./app-store-connect.ts"

test("Team API requests sign JWTs and follow pagination using GET", async context => {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-api-test-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const path = join(directory, "key.p8")
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  const urls: string[] = []
  const api = new AppStoreConnect({ APPLE_API_KEY_PATH: path, APPLE_API_KEY_ID: "KEY123", APPLE_API_ISSUER: "issuer" }, async (url, init) => {
    urls.push(String(url))
    assert.equal(init?.method ?? "GET", "GET")
    const token = new Headers(init?.headers).get("Authorization")!.slice("Bearer ".length)
    const [header, payload, signature] = token.split(".") as [string, string, string]
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEY123", typ: "JWT" })
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
    assert.equal(claims.iss, "issuer")
    assert.equal(claims.aud, "appstoreconnect-v1")
    assert.equal(claims.exp - claims.iat, 300)
    assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")))
    return Response.json({ data: [{ id: urls.length }], links: { next: urls.length === 1 ? "https://api.appstoreconnect.apple.com/v1/profiles?cursor=next" : null } })
  })
  assert.deepEqual(await api.list("/v1/profiles"), [{ id: 1 }, { id: 2 }])
  assert.equal(urls.length, 2)
  await assert.rejects(api.get("https://example.com/credentials"), /Apple's API origin/)
  assert.equal(urls.length, 2, "credentials must not be sent to a pagination URL on another origin")
})

test("API permission failures retain Apple's useful error without dumping responses", async context => {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-api-test-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const path = join(directory, "key.p8")
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  const api = new AppStoreConnect({ APPLE_API_KEY_PATH: path, APPLE_API_KEY_ID: "KEY123", APPLE_API_ISSUER: "issuer" }, async () => Response.json({ errors: [{ code: "FORBIDDEN", detail: "Cannot download this profile" }], unrelated: "not logged" }, { status: 403 }))
  await assert.rejects(api.get("/v1/profiles"), { message: "App Store Connect 403: FORBIDDEN: Cannot download this profile" })
})
