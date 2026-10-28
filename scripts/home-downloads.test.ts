import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fetchLatestRelease, findDownload, releasesPage, type LatestRelease } from "../docs/.vitepress/theme/components/home/home-downloads.ts"

const assetNames = [
  "deskfleet-0.2.0-mac-arm64.dmg", "deskfleet-0.2.0-mac-arm64.zip", "deskfleet-0.2.0-win-x64.exe",
  "deskfleet-0.2.0-linux-x86_64.AppImage", "deskfleet-0.2.0-linux-arm64.AppImage",
  "deskfleet-macos-arm64.tar.gz", "deskfleet-windows-x64.tar.gz", "deskfleet-linux-x64.tar.gz", "deskfleet-linux-arm64.tar.gz",
]
const release: LatestRelease = {
  version: "0.2.0", publishedAt: "2026-10-27T10:00:00Z",
  files: assetNames.map(name => ({ name, size: 100_000, url: `https://github.com/yet-another-ai/deskfleet/releases/download/v0.2.0/${name}` })),
}

test("download selection distinguishes installers, archives, and Linux architectures", () => {
  assert.equal(findDownload(release, "desktop", "macos", "x64")?.name, "deskfleet-0.2.0-mac-arm64.dmg")
  assert.equal(findDownload(release, "desktop", "windows", "arm64")?.name, "deskfleet-0.2.0-win-x64.exe")
  assert.equal(findDownload(release, "headless", "macos", "x64")?.name, "deskfleet-macos-arm64.tar.gz")
  assert.equal(findDownload(release, "headless", "windows", "arm64")?.name, "deskfleet-windows-x64.tar.gz")
  for (const arch of ["x64", "arm64"] as const) {
    const appImageArchitecture = arch === "x64" ? "x86_64" : "arm64"
    assert.equal(findDownload(release, "desktop", "linux", arch)?.name, `deskfleet-0.2.0-linux-${appImageArchitecture}.AppImage`)
    assert.equal(findDownload(release, "headless", "linux", arch)?.name, `deskfleet-linux-${arch}.tar.gz`)
  }
})

test("release verification accepts the installer names produced by packaging", { skip: process.platform === "win32" }, context => {
  const yaml = readFileSync(join(import.meta.dirname, "../.github/workflows/publish.yml"), "utf8")
  const block = yaml.match(/^      - name: Verify release assets\n[\s\S]*?^        run: \|\n((?:          .*\n)+)/m)?.[1]
  assert.ok(block, "Missing release asset verification step")
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-release-assets-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "release-assets"))
  for (const name of assetNames) writeFileSync(join(directory, "release-assets", name), "fixture")
  const verify = () => spawnSync("bash", ["-eo", "pipefail", "-c", block.replace(/^ {10}/gm, "")], {
    cwd: directory, env: { ...process.env, VERSION: release.version }, encoding: "utf8",
  })
  const result = verify()
  assert.equal(result.status, 0, result.stderr)
  unlinkSync(join(directory, "release-assets", "deskfleet-0.2.0-linux-x86_64.AppImage"))
  assert.notEqual(verify().status, 0, "A missing x86_64 installer must prevent publication")
})

test("the macOS ZIP alternative resolves independently of the primary installer", () => {
  const archive = findDownload(release, "desktop", "macos", "x64", "archive")
  assert.equal(archive?.name, "deskfleet-0.2.0-mac-arm64.zip")
  assert.equal(archive?.url, `${releasesPage.replace("/latest", "")}/download/v0.2.0/deskfleet-0.2.0-mac-arm64.zip`)
  const withoutArchive = { ...release, files: release.files.filter(file => !file.name.endsWith(".zip")) }
  assert.equal(findDownload(withoutArchive, "desktop", "macos", "x64", "archive"), undefined)
  assert.equal(findDownload(withoutArchive, "desktop", "macos", "x64")?.name, "deskfleet-0.2.0-mac-arm64.dmg")
  assert.equal(findDownload(release, "headless", "macos", "x64", "archive"), undefined)
  assert.equal(findDownload(release, "desktop", "linux", "x64", "archive"), undefined)
})

test("missing packages fall back to the release page without selecting another architecture", () => {
  const incomplete = { ...release, files: release.files.filter(file => file.name !== "deskfleet-0.2.0-linux-arm64.AppImage") }
  assert.equal(findDownload(incomplete, "desktop", "linux", "arm64")?.url ?? releasesPage, releasesPage)
  assert.equal(findDownload(undefined, "headless", "macos", "x64")?.url ?? releasesPage, releasesPage)
  assert.equal(findDownload({ ...release, version: "0.3.0" }, "desktop", "windows", "x64"), undefined)
})

function githubRelease(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${release.version}`, published_at: release.publishedAt, draft: false, prerelease: false,
    assets: release.files.map(file => ({ name: file.name, browser_download_url: file.url, size: file.size })),
    ...overrides,
  }
}

test("latest downloads use GitHub's stable-release endpoint without browser credentials", async context => {
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.github.com/repos/yet-another-ai/deskfleet/releases/latest")
    assert.deepEqual(options, { headers: { Accept: "application/vnd.github+json" } })
    return Response.json(githubRelease())
  })
  assert.deepEqual(await fetchLatestRelease(), release)
})

test("draft and prerelease metadata cannot replace the stable downloads", async context => {
  for (const overrides of [{ draft: true }, { prerelease: true }, { published_at: null }]) {
    const mock = context.mock.method(globalThis, "fetch", async () => Response.json(githubRelease(overrides)))
    assert.equal(await fetchLatestRelease(), undefined)
    mock.mock.restore()
  }
})

test("an unpublished release, rate limit, or network failure leaves release-page links usable", async context => {
  for (const status of [404, 403, 429, 500]) {
    const mock = context.mock.method(globalThis, "fetch", async () => new Response(null, { status }))
    assert.equal(await fetchLatestRelease(), undefined)
    mock.mock.restore()
  }
  context.mock.method(globalThis, "fetch", async () => { throw new TypeError("Network unavailable") })
  assert.equal(await fetchLatestRelease(), undefined)
})
