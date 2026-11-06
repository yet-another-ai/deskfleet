import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test, { type TestContext } from "node:test"
import {
  classifyChanges,
  classifyDocumentation,
  isBackendPath,
  isDocumentationDiff,
  isPackagingPath,
  isPlatformPath,
} from "./ci-docs-only.ts"

const sha = "a".repeat(40)
const record = (file: string, old = "100644", next = "100644", status = "M") =>
  `:${old} ${next} ${sha} ${sha} ${status}\0${file}\0`

test("only ordinary documentation files qualify", () => {
  for (const file of ["README.md", "AGENTS.md", "CONTRIBUTING.md", "docs/architecture.md", "agents/docs/ci.md"])
    assert.equal(isDocumentationDiff(record(file)), true, file)
  for (const file of ["Cargo.lock", "mise.lock", "apm.yml", ".agents/skills/rust-skills/SKILL.md",
    ".github/workflows/ci.yml", "scripts/check.ts", "docs/config.ts", "docs/icon.svg", "docs/a.md\ncode.rs"])
    assert.equal(isDocumentationDiff(record(file)), false, file)
  assert.equal(isDocumentationDiff(record("README.md", "000000", "100644", "A")), true)
  assert.equal(isDocumentationDiff(record("README.md", "100644", "000000", "D")), true)
  for (const mode of ["100755", "120000", "160000"]) {
    assert.equal(isDocumentationDiff(record("README.md", "100644", mode)), false)
    assert.equal(isDocumentationDiff(record("README.md", mode, "000000", "D")), false)
  }
  for (const raw of ["", "bad\0README.md\0", record("README.md").slice(0, -1), record("README.md") + record("Cargo.toml")])
    assert.equal(isDocumentationDiff(raw), false)
})

function temporary(context: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "deskfleet-ci-"))
  context.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test("classifies complete PR and push changes, including removals during renames", context => {
  const cwd = temporary(context)
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@example.invalid", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim()
  const save = (file: string, content: string) => {
    const full = join(cwd, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const snapshot = () => { git("add", "."); git("commit", "-qm", "Fixture"); return git("rev-parse", "HEAD") }
  const push = (before: string, after: string) => classifyDocumentation("push", "refs/heads/main", { before, after }, cwd)
  git("init", "-q", "-b", "main")
  save("README.md", "docs\n")
  save("source.rs", "source\n")
  const initial = snapshot()
  git("checkout", "-qb", "topic")
  save("README.md", "updated docs\n")
  const docs = snapshot()
  assert.equal(push(initial, docs), true)
  git("checkout", "-q", "main")
  save("source.rs", "main changed\n")
  const main = snapshot()
  const pr = (head: string) => classifyDocumentation("pull_request", "refs/pull/1/merge", {
    pull_request: { base: { sha: main }, head: { sha: head } }
  }, cwd)
  assert.equal(pr(docs), true, "unrelated base changes do not belong to the PR")
  git("checkout", "-q", "topic")
  save("source.rs", "topic changed\n")
  snapshot()
  save("README.md", "last commit only changes docs\n")
  const code = snapshot()
  assert.equal(pr(code), false, "the last commit cannot hide earlier source changes")
  git("rm", "README.md")
  git("mv", "source.rs", "README.md")
  assert.equal(push(code, snapshot()), false, "moving source into docs checks both paths")
  assert.equal(push(docs, docs), false)
  assert.equal(push("0".repeat(40), docs), false)
  assert.equal(push(sha, docs), false)
})

test("packaging detector covers desktop builder configs, staging scripts, and build inputs", () => {
  for (const file of [
    "apps/desktop/package.json",
    "apps/desktop/electron-builder.yml",
    "apps/desktop/electron-builder.release.yml",
    "apps/desktop/build/entitlements.mac.plist",
    "apps/desktop/build/windows-desktop-service.nsh",
    "apps/desktop/scripts/stage-native-viewer.ts",
    "apps/desktop/scripts/stage-windows-service.ts",
    "apps/desktop/scripts/stage-auv.ts",
    "scripts/stage-native-binaries.ts",
    "packaging/aur/PKGBUILD.in",
    ".github/workflows/build.yml",
  ]) assert.equal(isPackagingPath(file), true, file)
  for (const file of [
    "apps/desktop/src/main/index.ts",
    "apps/desktop/scripts/dev.ts",
    "apps/desktop/README.md",
    "scripts/check.ts",
    ".github/workflows/ci.yml",
  ]) assert.equal(isPackagingPath(file), false, file)
})

test("classifies draft PRs and packaging-related changes", context => {
  const cwd = temporary(context)
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@example.invalid", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim()
  const save = (file: string, content: string) => {
    const full = join(cwd, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const snapshot = () => { git("add", "."); git("commit", "-qm", "Fixture"); return git("rev-parse", "HEAD") }
  git("init", "-q", "-b", "main")
  save("README.md", "docs\n")
  save("source.rs", "source\n")
  const initial = snapshot()
  git("checkout", "-qb", "topic")
  save("source.rs", "modified source\n")
  const code = snapshot()

  // Standard Rust source change triggers platform matrix and backend integration
  assert.deepEqual(classifyChanges("pull_request", "refs/pull/1/merge", {
    pull_request: { base: { sha: initial }, head: { sha: code } }
  }, cwd), { docsOnly: false, runBuild: false, allPlatforms: true, runBackend: true })

  // Pure frontend UI change (apps/web) skips Windows/macOS matrix and backend integration
  save("apps/web/src/App.vue", "<template>hello</template>\n")
  const frontendSha = snapshot()
  assert.deepEqual(classifyChanges("pull_request", "refs/pull/1/merge", {
    pull_request: { base: { sha: code }, head: { sha: frontendSha } }
  }, cwd), { docsOnly: false, runBuild: false, allPlatforms: false, runBackend: false })

  // Draft PR skips runtime matrix and backend tests
  assert.deepEqual(classifyChanges("pull_request", "refs/pull/1/merge", {
    pull_request: { base: { sha: initial }, head: { sha: code }, draft: true }
  }, cwd), { docsOnly: false, runBuild: false, allPlatforms: false, runBackend: false })

  // Packaging change in PR triggers release build
  save("packaging/aur/PKGBUILD.in", "pkgbuild\n")
  const packagingSha = snapshot()
  assert.deepEqual(classifyChanges("pull_request", "refs/pull/1/merge", {
    pull_request: { base: { sha: initial }, head: { sha: packagingSha } }
  }, cwd), { docsOnly: false, runBuild: true, allPlatforms: true, runBackend: true })

  // Desktop electron-builder and staging inputs also trigger packaging
  save("apps/desktop/electron-builder.yml", "appId: test\n")
  const desktopPackaging = snapshot()
  assert.deepEqual(classifyChanges("pull_request", "refs/pull/1/merge", {
    pull_request: { base: { sha: initial }, head: { sha: desktopPackaging } }
  }, cwd), { docsOnly: false, runBuild: true, allPlatforms: true, runBackend: true })

  // Packaging change in Draft PR still skips release build until ready
  assert.deepEqual(classifyChanges("pull_request", "refs/pull/1/merge", {
    pull_request: { base: { sha: initial }, head: { sha: packagingSha }, draft: true }
  }, cwd), { docsOnly: false, runBuild: false, allPlatforms: false, runBackend: false })

  // Push to main always runs build and all platforms on code changes
  assert.deepEqual(classifyChanges("push", "refs/heads/main", {
    before: initial, after: code
  }, cwd), { docsOnly: false, runBuild: true, allPlatforms: true, runBackend: true })
})

test("platform and backend detectors cover shared actions and build-env paths", () => {
  for (const file of [
    ".github/actions/setup-build/action.yml",
    ".config/build-env/macos.toml",
    ".config/build-env/linux.toml",
    ".github/workflows/test.yml",
    "mise.toml",
    "packages/client/src/file-transfers.ts",
    "packages/mcp/src/index.ts",
  ]) {
    assert.equal(isPlatformPath(file), true, `platform:${file}`)
    assert.equal(isBackendPath(file), true, `backend:${file}`)
  }
  for (const file of ["apps/web/src/App.vue", "docs/guide.md", "README.md"]) {
    assert.equal(isPlatformPath(file), false, `platform:${file}`)
    assert.equal(isBackendPath(file), false, `backend:${file}`)
  }
})

test("manual Test workflow_dispatch declares full matrix and backend defaults", () => {
  const yaml = readFileSync(join(import.meta.dirname, "../.github/workflows/test.yml"), "utf8")
  const dispatch = yaml.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1]
  assert.ok(dispatch, "Missing workflow on: block")
  assert.match(dispatch, /workflow_dispatch:\n(?: {4}.+\n)*? {4}inputs:/)
  assert.match(dispatch, /workflow_dispatch:[\s\S]*?all_platforms:[\s\S]*?default:\s*true/)
  assert.match(dispatch, /workflow_dispatch:[\s\S]*?run_backend:[\s\S]*?default:\s*true/)
})

test("manual and scheduled runs, unrelated refs, and malformed events retain full validation", context => {
  for (const [eventName, ref] of [["workflow_dispatch", "refs/heads/main"], ["schedule", "refs/heads/main"], ["push", "refs/tags/v1"], ["push", "refs/heads/topic"]])
    assert.equal(classifyDocumentation(eventName, ref, { before: sha, after: sha }), false)
  assert.equal(classifyDocumentation("pull_request", "refs/pull/1/merge", {}), false)
  assert.equal(classifyDocumentation("push", "refs/heads/main", { before: "--help", after: sha }), false)
  const cwd = temporary(context)
  const eventPath = join(cwd, "event.json")
  const output = join(cwd, "output")
  for (const value of [undefined, "null", "{bad"]) {
    if (value !== undefined) writeFileSync(eventPath, value)
    writeFileSync(output, "")
    execFileSync(process.execPath, [join(import.meta.dirname, "ci-docs-only.ts")], {
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: "pull_request" }
    })
    assert.equal(
      readFileSync(output, "utf8"),
      "docs_only=false\nrun_build=true\nall_platforms=true\nrun_backend=true\n"
    )
  }
})

function workflowScript(job: string): string {
  const yaml = readFileSync(join(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8")
  const block = yaml.match(new RegExp(`^  ${job}:[\\s\\S]*?^        run: \\|\\n((?:          .*\\n)+)`, "m"))?.[1]
  assert.ok(block, `Missing shell step for ${job}`)
  return block.replace(/^ {10}/gm, "")
}

test("Build requires a successful Test before packaging", () => {
  const yaml = readFileSync(join(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8")
  const build = yaml.match(/^  build:[\s\S]*?(?=^  [a-z]|\z)/m)?.[0]
  assert.ok(build, "Missing Build job")
  assert.match(build, /needs:\s*\[changes,\s*test\]/)
  assert.match(build, /needs\.test\.result\s*==\s*'success'/)
})

test("actual Gate accepts only successful required jobs and explicitly allowed skips", { skip: process.platform === "win32" }, () => {
  const script = workflowScript("gate")
  const results = ["success", "failure", "cancelled", "skipped"]
  for (const changes of results) for (const tests of results) for (const build of results) for (const docs of ["true", "false", ""]) for (const runBuild of ["true", "false", ""]) {
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, CHANGES_RESULT: changes, TEST_RESULT: tests, BUILD_RESULT: build, DOCS_ONLY: docs, RUN_BUILD: runBuild }
    })
    const allowSkip = docs === "true" || runBuild === "false" || tests !== "success"
    assert.equal(result.status === 0, changes === "success" && tests === "success"
      && build === (allowSkip ? "skipped" : "success"),
      JSON.stringify({ changes, tests, build, docs, runBuild }))
  }
})

test("classifier process failure or missing output cannot skip CI", { skip: process.platform === "win32" }, context => {
  const script = workflowScript("changes")
  const cwd = temporary(context)
  const node = join(cwd, "node")
  const output = join(cwd, "output")
  for (const body of ["exit 0", 'echo "docs_only=true" >> "$GITHUB_OUTPUT"\nexit 1']) {
    writeFileSync(node, `#!/bin/sh\n${body}\n`)
    chmodSync(node, 0o755)
    writeFileSync(output, "")
    execFileSync("bash", ["-c", script], { env: { ...process.env, PATH: `${cwd}:${process.env.PATH}`, GITHUB_OUTPUT: output } })
    const lines = readFileSync(output, "utf8").trim().split("\n")
    assert.ok(lines.includes("docs_only=false"))
    assert.ok(lines.includes("run_build=true"))
    assert.ok(lines.includes("all_platforms=true"))
    assert.ok(lines.includes("run_backend=true"))
  }
})
