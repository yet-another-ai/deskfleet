import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { defaultWorktreePreferences } from "@deskfleet/protocol/worktree-preferences"
import { readRemoteAgentSettings, readWorktreePreferences, readWorktreeRoot } from "./host-settings.ts"
import { runSettingsCli } from "./settings-cli.ts"

async function invoke(directory: string, args: string[]): Promise<string> {
  const lines: string[] = []
  await runSettingsCli(args, { directory, log: line => lines.push(line) })
  return lines.join("\n")
}

test("settings CLI gets, sets, and resets remote agent and worktree settings", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-settings-cli-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const host = join(directory, "daemon")
  const customRoot = join(directory, "worktrees")

  const initial = JSON.parse(await invoke(host, [])) as { remoteAgents: Record<string, boolean>; worktrees: Record<string, unknown> }
  assert.equal(initial.remoteAgents.allowOperate, false)
  assert.deepEqual(initial.worktrees, { root: null, ...defaultWorktreePreferences() })

  await invoke(host, ["set", "remoteAgents.allowOperate", "true"])
  await invoke(host, ["set", "remoteAgents.allowSuperAgent", "true"])
  assert.equal(JSON.parse(await invoke(host, ["get", "remoteAgents.allowOperate"])), true)
  assert.equal((await readRemoteAgentSettings(host)).allowSuperAgent, true)

  await invoke(host, ["reset", "remoteAgents.allowOperate"])
  assert.equal((await readRemoteAgentSettings(host)).allowOperate, false)
  assert.equal((await readRemoteAgentSettings(host)).allowSuperAgent, true)
  await invoke(host, ["reset", "remoteAgents"])
  assert.equal((await readRemoteAgentSettings(host)).allowSuperAgent, false)

  await invoke(host, ["set", "worktrees.root", customRoot])
  assert.equal(await readWorktreeRoot(host), customRoot)
  assert.ok((await stat(customRoot)).isDirectory())

  await invoke(host, ["set", "worktrees.branchNaming", "session"])
  await invoke(host, ["set", "worktrees.cleanup.inactiveDays", "14"])
  await invoke(host, ["set", "worktrees.cleanup.keepLocalChanges", "all"])
  assert.equal((await readWorktreePreferences(host)).branchNaming, "session")
  assert.equal((await readWorktreePreferences(host)).cleanup.inactiveDays, 14)

  await invoke(host, ["reset", "worktrees"])
  assert.equal(await readWorktreeRoot(host), null)
  assert.deepEqual(await readWorktreePreferences(host), defaultWorktreePreferences())
})

test("settings CLI validates input and prints help", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-settings-cli-"))
  context.after(() => rm(directory, { recursive: true, force: true }))

  assert.match(await invoke(directory, ["--help"]), /remoteAgents\.allowOperate/u)
  await assert.rejects(invoke(directory, ["set", "remoteAgents.allowOperate", "yes"]), /expected true or false/u)
  await assert.rejects(invoke(directory, ["set", "worktrees.cleanup.inactiveDays", "0"]), /between 1 and 3650/u)
  await assert.rejects(invoke(directory, ["set", "worktrees.root", "null"]), /reset worktrees\.root/u)
  await assert.rejects(invoke(directory, ["set", "remoteAgents.unknown", "true"]), /Unknown setting key/u)
  await assert.rejects(invoke(directory, ["unknown"]), /Unknown settings action/u)
})
