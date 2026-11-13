import { createPrivateKey, sign, type KeyObject } from "node:crypto"
import { readFileSync } from "node:fs"

const origin = "https://api.appstoreconnect.apple.com"

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export class AppStoreConnect {
  private readonly key: KeyObject
  private readonly keyId: string
  private readonly issuer: string
  private readonly fetcher: typeof fetch

  constructor(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
    this.key = createPrivateKey(readFileSync(requiredEnv(env, "APPLE_API_KEY_PATH")))
    this.keyId = requiredEnv(env, "APPLE_API_KEY_ID")
    this.issuer = requiredEnv(env, "APPLE_API_ISSUER")
    this.fetcher = fetcher
  }

  async get<T>(path: string): Promise<T> {
    const url = new URL(path, origin)
    if (url.origin !== origin) throw new Error("App Store Connect requests must stay on Apple's API origin")
    const now = Math.floor(Date.now() / 1000)
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const payload = `${encode({ alg: "ES256", kid: this.keyId, typ: "JWT" })}.${encode({ iss: this.issuer, iat: now, exp: now + 300, aud: "appstoreconnect-v1" })}`
    const signature = sign("sha256", Buffer.from(payload), { key: this.key, dsaEncoding: "ieee-p1363" }).toString("base64url")
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${payload}.${signature}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { errors?: { code?: string, detail?: string }[] }
      const detail = body.errors?.map(error => `${error.code ?? "API_ERROR"}: ${error.detail ?? "Request failed"}`).join("; ")
      throw new Error(`App Store Connect ${response.status}${detail ? `: ${detail}` : ""}`)
    }
    return await response.json() as T
  }

  async list<T>(path: string): Promise<T[]> {
    const values: T[] = []
    let next: string | null | undefined = path
    while (next) {
      const page: { data: T[], links?: { next?: string | null } } = await this.get(next)
      values.push(...page.data)
      next = page.links?.next
    }
    return values
  }
}
