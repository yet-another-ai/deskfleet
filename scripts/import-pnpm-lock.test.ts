import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import test from "node:test"

const root = join(import.meta.dirname, "..")
const webNix = readFileSync(join(root, "nix/web.nix"), "utf8")
const importPnpmLock = readFileSync(join(root, "nix/import-pnpm-lock/importPnpmLock.nix"), "utf8")
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")

class LockfileParseError extends Error {}

function parseLockfilePackages(text: string): { version: string | null; packages: Map<string, string> } {
  const packages = new Map<string, string>()
  let version: string | null = null
  let inPackages = false
  let current: string | null = null
  const requireNoPending = (context: string) => {
    if (current !== null) {
      throw new LockfileParseError(`Package ${current} has no single-line integrity resolution (${context}).`)
    }
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/u, "")
    const versionMatch = /^lockfileVersion:\s*['"]?([^'"]+)['"]?\s*$/u.exec(line)
    if (version === null && versionMatch) version = versionMatch[1] ?? null
    if (line === "packages:") {
      requireNoPending("entering packages")
      inPackages = true
      current = null
      continue
    }
    const topLevel = /^([A-Za-z][^:]*):\s*$/u.exec(line)
    if (inPackages && topLevel && topLevel[1] !== "packages") {
      requireNoPending("leaving packages")
      inPackages = false
      current = null
      continue
    }
    const key = /^  (?:'([^']+)'|"([^"]+)"|([^:\s]+)):\s*$/u.exec(line)
    const name = key?.[1] ?? key?.[2] ?? key?.[3] ?? null
    if (inPackages && name && /.+@.+/u.test(name)) {
      requireNoPending(`starting ${name}`)
      current = name
      continue
    }
    const integrity = /^    resolution: \{integrity: (.*)\}$/u.exec(line)
    if (inPackages && current && integrity?.[1]) {
      packages.set(current, integrity[1])
      current = null
      continue
    }
    const resolution = /^    resolution: (.*)$/u.exec(line)
    if (inPackages && current && resolution) {
      throw new LockfileParseError(
        `Package ${current} has unsupported resolution \`${resolution[1]}\`.`,
      )
    }
  }
  requireNoPending("end of lockfile")
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
  assert.match(importCode, /requireNoPendingPackage/)
  assert.match(importCode, /unsupported resolution/)
  assert.doesNotMatch(importCode, /\brunCommand\b/)
  assert.doesNotMatch(importCode, /\byq-go\b/)
  assert.doesNotMatch(importCode, /\bimportJSON\b/)
  assert.doesNotMatch(importCode, /\bimportYAMLDocuments\b/)
})

test("pnpm-lock.yaml matches the pure Nix parser's integrity-only package contract", () => {
  // Normalize first so Windows CRLF checkouts do not become `\r\r\n`.
  const lf = lockfile.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  for (const text of [lf, lf.replaceAll("\n", "\r\n")]) {
    const { version, packages } = parseLockfilePackages(text)
    assert.equal(version, "9.0")
    assert.ok(packages.size > 0, "expected locked packages")
    for (const [name, integrity] of packages) {
      assert.match(name, /.+@.+/u)
      assert.doesNotMatch(name, /\(/u, `peer-suffixed keys need Nix parser updates: ${name}`)
      assert.match(integrity, /^sha512-/u, name)
    }
  }
})

test("parser rejects non-integrity package resolutions instead of skipping them", () => {
  const unsupported = `lockfileVersion: '9.0'

packages:

  'left-pad@1.3.0':
    resolution: {integrity: sha512-abc=}

  'weird-git@1.0.0':
    resolution: {type: git, repo: https://example.invalid/repo.git, commit: deadbeef}

snapshots:
`
  assert.throws(
    () => parseLockfilePackages(unsupported),
    error => error instanceof LockfileParseError && /weird-git@1\.0\.0/.test(String(error)) && /unsupported resolution/.test(String(error)),
  )

  const missing = `lockfileVersion: '9.0'

packages:

  'left-pad@1.3.0':
    engines: {node: '>=0'}

snapshots:
`
  assert.throws(
    () => parseLockfilePackages(missing),
    error => error instanceof LockfileParseError && /left-pad@1\.3\.0/.test(String(error)) && /no single-line integrity/.test(String(error)),
  )
})

test("Nix importPnpmLock fails evaluation on unsupported resolutions when Nix is available", context => {
  const probe = spawnSync("nix", ["--version"], { encoding: "utf8" })
  if (probe.status !== 0) {
    context.skip("nix is not installed in this environment")
    return
  }
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-pnpm-lock-"))
  const lockPath = join(directory, "pnpm-lock.yaml")
  writeFileSync(lockPath, `lockfileVersion: '9.0'

packages:

  'left-pad@1.3.0':
    resolution: {integrity: sha512-abc=}

  'weird-git@1.0.0':
    resolution: {type: git, repo: https://example.invalid/repo.git, commit: deadbeef}
`)
  const expression = `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(root)});
      pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; };
      inherit (pkgs.callPackage ${JSON.stringify(join(root, "nix/import-pnpm-lock"))} { }) importPnpmLock;
    in importPnpmLock {
      pname = "deskfleet-web";
      version = "0.0.0";
      lockFile = ${JSON.stringify(lockPath)};
    }
  `
  const result = spawnSync(
    "nix",
    ["eval", "--impure", "--expr", expression],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NIX_CONFIG: "experimental-features = nix-command flakes" },
    },
  )
  assert.notEqual(result.status, 0)
  assert.match(`${result.stderr}\n${result.stdout}`, /weird-git@1\.0\.0/)
  assert.match(`${result.stderr}\n${result.stdout}`, /unsupported resolution/)
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
