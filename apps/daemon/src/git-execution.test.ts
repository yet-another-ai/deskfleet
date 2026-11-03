import assert from "node:assert/strict"
import childProcess, { execFile } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir, userInfo } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { promisify } from "node:util"
import test, { type TestContext } from "node:test"
import { executeGit } from "./git-execution.ts"

const exec = promisify(execFile)
const git = async (root: string, ...args: string[]) => (await exec("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })).stdout.trimEnd()

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-git-policy-")))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "repo")
  await mkdir(root)
  await git(root, "init", "--initial-branch=main")
  await git(root, "config", "core.autocrlf", "false")
  await writeFile(join(root, "file.txt"), "source\n")
  await git(root, "add", ".")
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@fixture.invalid", "commit", "--no-gpg-sign", "-m", "initial")
  return { directory, root, marker: join(directory, "executed") }
}

test("safe Git supports linked worktrees and shared metadata operations", async t => {
  const { directory, root } = await fixture(t)
  const linked = join(directory, "linked")
  await git(root, "worktree", "add", "--detach", linked, "HEAD")
  assert.equal((await executeGit(["-C", linked, "status", "--porcelain"])).stdout, "")
  const common = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
  assert.match((await executeGit(["--git-dir", common, "worktree", "list"])).stdout, /linked/)
})

test("Git status accepts unrelated repository and branch configuration", async t => {
  const { root } = await fixture(t)
  await git(root, "config", "branch.feat/mark-session-unread.vscode-merge-base", "origin/main")
  await git(root, "config", "branch.feat/mark-session-unread.unknown", "value")
  await git(root, "config", "some-tool.custom-setting", "value")
  await git(root, "config", "filter.example.description", "metadata")
  await git(root, "config", "http.custom-setting", "value")
  await writeFile(join(root, "file.txt"), "changed\n")
  assert.match((await executeGit(["-C", root, "status", "--porcelain"])).stdout, / M file\.txt/)
  await git(root, "config", "extensions.worktreeConfig", "true")
  await git(root, "config", "--worktree", "some-tool.worktree-setting", "value")
  assert.match((await executeGit(["-C", root, "status", "--porcelain"])).stdout, / M file\.txt/)
})

test("Git rejects common-config worktree redirection before touching a victim directory", async t => {
  const { root, directory } = await fixture(t)
  const victim = join(directory, "victim")
  await mkdir(victim)
  await writeFile(join(victim, "file.txt"), "private contents\n")
  await git(root, "config", "core.worktree", victim)
  for (const args of [["-C", root, "reset", "--hard", "HEAD"], ["--git-dir", join(root, ".git"), "worktree", "list"]]) {
    await assert.rejects(executeGit(args), /core.worktree redirects/)
    assert.equal(await readFile(join(victim, "file.txt"), "utf8"), "private contents\n")
  }
})

test("Git accepts absent and empty worktree config in main and linked checkouts", async t => {
  const { directory, root } = await fixture(t)
  const linked = join(directory, "linked")
  await git(root, "worktree", "add", "--detach", linked, "HEAD")
  await git(root, "config", "extensions.worktreeConfig", "true")
  for (const checkout of [root, linked]) {
    const config = await git(checkout, "rev-parse", "--path-format=absolute", "--git-path", "config.worktree")
    await assert.rejects(readFile(config), { code: "ENOENT" })
    assert.equal((await executeGit(["-C", checkout, "status", "--porcelain"])).stdout, "")
    await writeFile(config, "")
    assert.equal((await executeGit(["-C", checkout, "status", "--porcelain"])).stdout, "")
    await writeFile(config, "[invalid\n")
    await assert.rejects(executeGit(["-C", checkout, "status", "--porcelain"]), /bad config/)
    await rm(config)
  }
  assert.match((await executeGit(["--git-dir", join(root, ".git"), "worktree", "list"])).stdout, /linked/)
})

test("Git validates worktree-local redirection while retaining valid layout metadata", async t => {
  const { root, directory } = await fixture(t)
  await git(root, "config", "core.worktree", "..")
  assert.equal((await executeGit(["-C", root, "status", "--porcelain"])).stdout, "")
  await git(root, "config", "--unset", "core.worktree")
  const linked = join(directory, "linked")
  await git(root, "worktree", "add", "--detach", linked, "HEAD")
  await git(root, "config", "extensions.worktreeConfig", "true")
  await git(linked, "config", "--worktree", "core.worktree", root)
  await assert.rejects(executeGit(["-C", linked, "reset", "--hard", "HEAD"]), /core.worktree redirects/)
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "source\n")
})

for (const key of ["core.fsmonitor", "core.sshCommand", "credential.helper", "credential.https://example.com.helper", "filter.attack.smudge", "filter.attack.process", "remote.origin.uploadpack", "hook.attack.command", "hook.attack.event", "merge.attack.driver", "gc.recentObjectsHook", "branch.main.mergeOptions", "url.file:///tmp.insteadOf", "http.sslVerify"]) {
  test(`Git rejects restricted repository configuration: ${key}`, async t => {
    const { root, marker } = await fixture(t)
    await git(root, "config", key, `!echo executed > '${marker.replaceAll("\\", "/")}'`)
    await assert.rejects(executeGit(["-C", root, "status", "--porcelain"]), /Repository-local Git configuration/)
    await assert.rejects(readFile(marker), { code: "ENOENT" })
  })
}

test("Git rejects includes before following executable policy", async t => {
  const { root, directory, marker } = await fixture(t)
  const included = join(directory, "included.config")
  await writeFile(included, `[core]\nfsmonitor = echo executed > '${marker.replaceAll("\\", "/")}'\n`)
  await git(root, "config", "include.path", included)
  await assert.rejects(executeGit(["-C", root, "status", "--porcelain"]), /include.path/)
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

for (const key of ["gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program", "gpg.ssh.defaultKeyCommand"]) {
  test(`Git rejects repository signing programs before merge: ${key}`, async t => {
    const { root, marker } = await fixture(t)
    await git(root, "config", "merge.verifySignatures", "true")
    await git(root, "config", key, `echo executed > '${marker.replaceAll("\\", "/")}'`)
    await assert.rejects(executeGit(["-C", root, "merge", "--ff-only", "HEAD"]), /Repository-local Git configuration/)
    await assert.rejects(readFile(marker), { code: "ENOENT" })
  })
}

test("Git fetch does not recurse into submodules despite repository settings", async t => {
  const { root, directory } = await fixture(t)
  const source = join(directory, "module-source")
  await git(directory, "clone", root, source)
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", source, "module")
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@fixture.invalid", "commit", "--no-gpg-sign", "-m", "add module")
  const remote = join(directory, "remote.git")
  await git(directory, "clone", "--bare", root, remote)
  await git(root, "remote", "add", "origin", remote)
  const module = join(root, "module")
  const before = await git(module, "rev-parse", "refs/remotes/origin/main")
  await writeFile(join(source, "file.txt"), "new revision\n")
  await git(source, "add", "file.txt")
  await git(source, "-c", "user.name=Test", "-c", "user.email=test@fixture.invalid", "commit", "--no-gpg-sign", "-m", "update module")
  const after = await git(source, "rev-parse", "HEAD")
  assert.notEqual(before, after)
  await git(root, "config", "fetch.recurseSubmodules", "true")
  await git(root, "config", "submodule.module.fetchRecurseSubmodules", "true")
  await executeGit(["-C", root, "fetch", "--no-tags", "--", "origin", "+refs/heads/main:refs/remotes/origin/main"])
  assert.equal(await git(module, "rev-parse", "refs/remotes/origin/main"), before)
  // Prove that the configured recursive fetch would have updated the submodule.
  await git(root, "-c", "protocol.file.allow=always", "fetch", "--no-tags", "origin")
  assert.equal(await git(module, "rev-parse", "refs/remotes/origin/main"), after)
})

test("Git never runs ordinary repository hooks during generated worktree checkout", async t => {
  const { root, directory, marker } = await fixture(t)
  await writeFile(join(root, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho executed > '${marker.replaceAll("\\", "/")}'\n`, { mode: 0o700 })
  await executeGit(["-C", root, "worktree", "add", "--detach", join(directory, "generated"), "HEAD"])
  const generated = join(directory, "generated")
  await writeFile(join(root, ".git", "hooks", "reference-transaction"), `#!/bin/sh\necho executed > '${marker.replaceAll("\\", "/")}'\n`, { mode: 0o700 })
  await executeGit(["-C", generated, "reset", "--hard", "HEAD"])
  await executeGit(["-C", root, "update-ref", "refs/deskfleet/test", "HEAD"])
  await executeGit(["-C", root, "worktree", "remove", "--force", generated])
  await executeGit(["-C", root, "update-ref", "-d", "refs/deskfleet/test"])
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("Git rejects executable worktree-local policy", async t => {
  const { root, directory, marker } = await fixture(t)
  const linked = join(directory, "linked")
  await git(root, "worktree", "add", "--detach", linked, "HEAD")
  await git(root, "config", "extensions.worktreeConfig", "true")
  await git(linked, "config", "--worktree", "core.fsmonitor", `echo executed > '${marker.replaceAll("\\", "/")}'`)
  await assert.rejects(executeGit(["-C", linked, "status", "--porcelain"]), /core.fsmonitor/)
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("Git disables external diff and textconv even when selected by attributes", async t => {
  const { root, marker } = await fixture(t)
  const command = `echo executed > '${marker.replaceAll("\\", "/")}'`
  await git(root, "config", "diff.external", command)
  await git(root, "config", "diff.attack.textconv", command)
  await writeFile(join(root, ".gitattributes"), "file.txt diff=attack\n")
  await writeFile(join(root, "file.txt"), "changed\n")
  assert.match((await executeGit(["-C", root, "diff", "--", "file.txt"])).stdout, /changed/)
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("Git blocks ext remote helpers and checks metadata at local fetch targets", async t => {
  const { root, directory, marker } = await fixture(t)
  await git(root, "remote", "add", "origin", `ext::sh -c echo% executed% >% '${marker.replaceAll("\\", "/")}'`)
  await assert.rejects(executeGit(["-C", root, "ls-remote", "--", "origin", "HEAD"]), /transport.*ext.*not allowed/)
  await assert.rejects(readFile(marker), { code: "ENOENT" })
  const remote = join(directory, "remote.git")
  await git(directory, "init", "--bare", remote)
  await git(remote, "config", "core.alternateRefsCommand", "echo executed")
  await git(root, "remote", "set-url", "origin", remote)
  await assert.rejects(executeGit(["-C", root, "ls-remote", "--", "origin", "HEAD"]), /core.alternaterefscommand/)
})

test("Git neutralizes host-configured filters selected by untrusted attributes", async t => {
  const { root, directory, marker } = await fixture(t)
  await writeFile(join(root, ".gitattributes"), "file.txt filter=attack\n")
  await git(root, "add", ".gitattributes")
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@fixture.invalid", "commit", "--no-gpg-sign", "-m", "attributes")
  const global = join(directory, ".gitconfig")
  await git(root, "config", "--file", global, "core.autocrlf", "true")
  await git(root, "config", "--file", global, "filter.attack.smudge", `echo executed > '${marker.replaceAll("\\", "/")}'; cat`)
  await git(root, "config", "--file", global, "filter.attack.required", "true")
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]) {
    const previous = process.env[key]
    process.env[key] = directory
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const generated = join(directory, "generated")
  await executeGit(["-C", root, "worktree", "add", "--detach", generated, "HEAD"])
  assert.equal(await readFile(join(generated, "file.txt"), "utf8"), "source\n")
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("Git checks submodule policy even when the Workspace binding is a sibling subdirectory", async t => {
  const { root, directory, marker } = await fixture(t)
  const source = join(directory, "module-source")
  await git(directory, "clone", root, source)
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", source, "module")
  await mkdir(join(root, "binding"))
  await git(join(root, "module"), "config", "core.fsmonitor", `echo executed > '${marker.replaceAll("\\", "/")}'`)
  await assert.rejects(executeGit(["-C", join(root, "binding"), "status", "--porcelain"]), /core.fsmonitor/)
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("Git preflight shares the caller's deadline and never starts the operation after expiry", async t => {
  const { root } = await fixture(t)
  let elapsed = 0, startedOperation = false
  const timeouts: number[] = []
  const clock = t.mock.method(performance, "now", () => elapsed)
  const processMock = t.mock.method(childProcess, "execFile", (...args: Parameters<typeof childProcess.execFile>) => {
    const argv = args[1] as string[]
    const options = args[2] as { timeout: number }
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
    timeouts.push(options.timeout)
    elapsed += 40
    if (argv.includes("status")) startedOperation = true
    const stdout = argv.includes("rev-parse") ? root + "\n" : ""
    queueMicrotask(() => callback(null, stdout, ""))
    return { stdin: { on() {}, end() {} } } as unknown as ReturnType<typeof childProcess.execFile>
  })
  syncBuiltinESMExports()
  t.after(() => { processMock.mock.restore(); clock.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(executeGit(["-C", root, "status", "--porcelain"], { timeout: 100 }), { code: "ETIMEDOUT" })
  assert.equal(timeouts[0], 100)
  assert.ok(timeouts.slice(1).every((timeout, index) => timeout > 0 && timeout < timeouts[index]!))
  assert.equal(startedOperation, false)
})

test("Git expands tilde local remotes before inspecting and fetching them", async t => {
  const { root, directory } = await fixture(t)
  const remote = join(directory, "remote.git")
  await git(directory, "clone", "--bare", root, remote)
  const path = relative(homedir(), remote)
  if (isAbsolute(path)) { t.skip("temporary directory is on a different Windows volume from home"); return }
  await git(root, "remote", "add", "origin", "~/" + path.split(sep).join("/"))
  const head = await git(root, "rev-parse", "HEAD")
  assert.match((await executeGit(["-C", root, "ls-remote", "--", "origin", "HEAD"])).stdout, new RegExp(head))
  await executeGit(["-C", root, "fetch", "--no-tags", "--", "origin", "+refs/heads/main:refs/remotes/origin/main"])
  assert.equal(await git(root, "rev-parse", "refs/remotes/origin/main"), head)
  if (process.platform !== "win32") {
    await git(root, "remote", "set-url", "origin", `~${userInfo().username}/` + path.split(sep).join("/"))
    assert.match((await executeGit(["-C", root, "ls-remote", "--", "origin", "HEAD"])).stdout, new RegExp(head))
  }
})
