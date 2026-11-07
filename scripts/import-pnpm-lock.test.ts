import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const root = join(import.meta.dirname, "..")
const webNix = readFileSync(join(root, "nix/web.nix"), "utf8")
const importPnpmLock = readFileSync(join(root, "nix/import-pnpm-lock/importPnpmLock.nix"), "utf8")
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")

function parseLockfilePackages(text: string): { version: string | null; packages: Map<string, string> } {
  const packages = new Map<string, string>()
  let version: string | null = null
  let inPackages = false
  let current: string | null = null
  for (const line of text.split("\n")) {
    const versionMatch = /^lockfileVersion:\s*['"]?([^'"]+)['"]?\s*$/u.exec(line)
    if (version === null && versionMatch) version = versionMatch[1] ?? null
    if (line === "packages:") {
      inPackages = true
      current = null
      continue
    }
    const topLevel = /^([A-Za-z][^:]*):\s*$/u.exec(line)
    if (inPackages && topLevel && topLevel[1] !== "packages") {
      inPackages = false
      current = null
      continue
    }
    const key = /^  (?:'([^']+)'|"([^"]+)"|([^:\s]+)):\s*$/u.exec(line)
    const name = key?.[1] ?? key?.[2] ?? key?.[3] ?? null
    if (inPackages && name && /.+@.+/u.test(name)) {
      current = name
      continue
    }
    const integrity = /^    resolution: \{integrity: (.*)\}$/u.exec(line)
    if (inPackages && current && integrity?.[1]) {
      packages.set(current, integrity[1])
      current = null
    }
  }
  return { version, packages }
}

function codeWithoutComments(source: string): string {
  return source
    .split("\n")
    .filter(line => !/^\s*#/u.test(line))
    .join("\n")
}

test("Web Nix deps stay lockfile-driven without aggregate FOD hash or IFD", () => {
  const webCode = codeWithoutComments(webNix)
  const importCode = codeWithoutComments(importPnpmLock)

  assert.match(webCode, /importPnpmLock/)
  assert.match(webCode, /iplConfigHook/)
  assert.match(webCode, /mitmCache/)
  assert.doesNotMatch(webCode, /\bfetchPnpmDeps\b/)
  assert.doesNotMatch(webCode, /\bpnpmDeps\b/)
  assert.doesNotMatch(webCode, /hash\s*=\s*"sha256-/)

  assert.match(importCode, /builtins\.readFile lockFile/)
  assert.doesNotMatch(importCode, /\brunCommand\b/)
  assert.doesNotMatch(importCode, /\byq-go\b/)
  assert.doesNotMatch(importCode, /\bimportJSON\b/)
  assert.doesNotMatch(importCode, /\bimportYAMLDocuments\b/)
})

test("pnpm-lock.yaml matches the pure Nix parser's integrity-only package contract", () => {
  const { version, packages } = parseLockfilePackages(lockfile)
  assert.equal(version, "9.0")
  assert.ok(packages.size > 0, "expected locked packages")
  for (const [name, integrity] of packages) {
    assert.match(name, /.+@.+/u)
    assert.doesNotMatch(name, /\(/u, `peer-suffixed keys need Nix parser updates: ${name}`)
    assert.match(integrity, /^sha512-/u, name)
  }
})

test("multi-arch flake eval stays IFD-free when Nix is available", context => {
  const probe = spawnSync("nix", ["--version"], { encoding: "utf8" })
  if (probe.status !== 0) {
    context.skip("nix is not installed in this environment")
    return
  }
  const result = spawnSync(
    "nix",
    ["flake", "check", "--no-build", "--all-systems"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NIX_CONFIG: "experimental-features = nix-command flakes" },
    },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
