import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { cleanup, docker, printLogs, publishedPort, ready, startPostgres } from "./fixtures/image-smoke.ts"

const image = process.argv[2]
if (!image) throw new Error("Usage: node scripts/smoke-server-image.ts <image>")

const prefix = `deskfleet-image-smoke-${randomUUID()}`
const database = `${prefix}-postgres`
const server = `${prefix}-server`
const immutableCacheControl = "public, max-age=31536000, immutable"

try {
  docker("network", "create", prefix)
  await startPostgres(prefix, database)

  docker("run", "--detach", "--name", server, "--network", prefix,
    "--publish", "127.0.0.1::8080", "--env",
    "DATABASE_URL=postgres://postgres:smoke-test@postgres:5432/deskfleet", image)
  const port = publishedPort(server, 8080)
  assert.equal(docker("inspect", "--format", "{{.Config.User}}", server), "10001:10001")
  await ready("the container HTTP listener", async () => {
    assert.equal(docker("inspect", "--format", "{{.State.Running}}", server), "true",
      "Server exited before becoming ready")
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) return false
      const health = await response.json() as { status: string; protocol_version: number }
      assert.equal(health.status, "ok")
      assert.equal(health.protocol_version, 1)
      return true
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error
      return false
    }
  })
  const containerHealth = docker(
    "exec",
    server,
    "bash",
    "-c",
    "curl -fsS http://127.0.0.1:8080/healthz | jq -er '.status == \"ok\" and .protocol_version == 1'",
  )
  assert.equal(containerHealth, "true", "Server image must include bash, curl, and jq for health checks")
  const origin = `http://127.0.0.1:${port}`
  const homepage = await fetch(origin, { signal: AbortSignal.timeout(5_000) })
  assert.equal(homepage.status, 200)
  assert.match(homepage.headers.get("content-type") ?? "", /^text\/html(?:;|$)/)
  assert.equal(homepage.headers.get("cache-control"), "no-cache")
  const html = await homepage.text()
  assert.match(html, /<div id="root"><\/div>/)
  const homepageEtag = homepage.headers.get("etag")
  assert.ok(homepageEtag, "The Web entry point must support conditional requests")
  const unchangedHomepage = await fetch(origin, {
    headers: { "If-None-Match": homepageEtag }, signal: AbortSignal.timeout(5_000),
  })
  assert.equal(unchangedHomepage.status, 304)
  assert.equal(unchangedHomepage.headers.get("cache-control"), "no-cache")
  assert.equal(await unchangedHomepage.text(), "")

  const account = await fetch(`${origin}/auth/account`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(account.status, 200)
  assert.match(account.headers.get("content-type") ?? "", /^text\/html(?:;|$)/)
  assert.equal(account.headers.get("cache-control"), "no-cache")
  assert.equal(await account.text(), html, "Authentication pages must serve the bundled Web entry point")

  const accountHead = await fetch(`${origin}/auth/account`, {
    method: "HEAD", signal: AbortSignal.timeout(5_000),
  })
  assert.equal(accountHead.status, 200)
  assert.match(accountHead.headers.get("content-type") ?? "", /^text\/html(?:;|$)/)
  assert.equal(accountHead.headers.get("cache-control"), "no-cache")
  assert.equal(await accountHead.text(), "", "HEAD must return headers without the Web entry point body")

  for (const [extension, contentType] of [
    ["js", /^(?:text|application)\/javascript(?:;|$)/],
    ["css", /^text\/css(?:;|$)/],
  ] as const) {
    const path = html.match(new RegExp(`(?:src|href)="([^"]+\\.${extension})"`))?.[1]
    assert.ok(path, `Web entry point must reference a built ${extension} asset`)
    const url = new URL(path, origin)
    assert.equal(url.origin, origin, "Bundled Web assets must be served from the same origin")
    assert.match(url.pathname, /^\/assets\/.+-[A-Za-z0-9_-]{8}\.[^.]+$/,
      "Bundled assets must retain Vite's content-hashed filenames")
    const asset = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    assert.equal(asset.status, 200, `Missing bundled asset: ${path}`)
    assert.match(asset.headers.get("content-type") ?? "", contentType)
    assert.equal(asset.headers.get("cache-control"), immutableCacheControl)
    const etag = asset.headers.get("etag")
    assert.ok(etag, `Bundled asset must support conditional requests: ${path}`)
    assert.ok((await asset.text()).length > 0, `Bundled asset is empty: ${path}`)

    const assetHead = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) })
    assert.equal(assetHead.status, 200)
    assert.equal(assetHead.headers.get("cache-control"), immutableCacheControl)
    assert.equal(await assetHead.text(), "")

    const unchangedAsset = await fetch(url, {
      headers: { "If-None-Match": etag }, signal: AbortSignal.timeout(5_000),
    })
    assert.equal(unchangedAsset.status, 304)
    assert.equal(unchangedAsset.headers.get("cache-control"), immutableCacheControl)
    assert.equal(await unchangedAsset.text(), "")
  }

  const icon = await fetch(`${origin}/favicon-32x32.png`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get("cache-control"), "no-cache",
    "Fixed-name assets must revalidate after image upgrades")
  assert.ok((await icon.arrayBuffer()).byteLength > 0)

  const site = await fetch(`${origin}/api/site`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(site.status, 200)
  assert.match(site.headers.get("content-type") ?? "", /^application\/json(?:;|$)/)
  const settings = await site.json() as { siteName: string }
  assert.equal(typeof settings.siteName, "string", "API routing must retain database-backed site settings")

  for (const path of ["/api/not-a-route", "/assets/not-a-bundle.js", "/assets/missing-a1b2C3_d.js"]) {
    const missing = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5_000) })
    assert.equal(missing.status, 404, `${path} must not fall back to the Web entry point`)
    if (path.startsWith("/assets/")) {
      assert.equal(missing.headers.get("cache-control"), "no-store",
        "Missing assets must not be cached, including content-hashed filenames")
    }
    assert.notEqual(await missing.text(), html)
  }
  docker("stop", "--time", "15", server)
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", server), "0",
    "Server did not shut down gracefully")
  console.log("Server image: non-root startup, PostgreSQL migrations, same-origin Web/API routing, asset caching and revalidation, 404s, and shutdown passed")
} catch (error) {
  printLogs(server, database)
  throw error
} finally {
  cleanup(prefix, server, database)
}
