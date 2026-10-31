import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { classifyDocumentation, isDocumentationDiff } from "./ci-docs-only.ts"

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
  const save = (file: string, content: string) => writeFileSync(join(cwd, file), content)
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

test("manual runs, unrelated refs, and malformed events retain full validation", context => {
  for (const [eventName, ref] of [["workflow_dispatch", "refs/heads/main"], ["push", "refs/tags/v1"], ["push", "refs/heads/topic"]])
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
    assert.equal(readFileSync(output, "utf8"), "docs_only=false\n")
  }
})

function workflowScript(job: string): string {
  const yaml = readFileSync(join(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8")
  const block = yaml.match(new RegExp(`^  ${job}:[\\s\\S]*?^        run: \\|\\n((?:          .*\\n)+)`, "m"))?.[1]
  assert.ok(block, `Missing shell step for ${job}`)
  return block.replace(/^ {10}/gm, "")
}

test("actual Gate accepts only successful required jobs and explicitly allowed skips", { skip: process.platform === "win32" }, () => {
  const script = workflowScript("gate")
  const results = ["success", "failure", "cancelled", "skipped"]
  for (const changes of results) for (const tests of results) for (const build of results) for (const nix of results) for (const docs of ["true", "false", ""]) {
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, CHANGES_RESULT: changes, TEST_RESULT: tests, BUILD_RESULT: build, NIX_RESULT: nix, DOCS_ONLY: docs }
    })
    assert.equal(result.status === 0, changes === "success" && tests === "success"
      && build === (docs === "true" ? "skipped" : "success") && nix === (docs === "true" ? "skipped" : "success"),
      JSON.stringify({ changes, tests, build, nix, docs }))
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
    assert.equal(readFileSync(output, "utf8").trim().split("\n").at(-1), "docs_only=false")
  }
})
