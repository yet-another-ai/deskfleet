import { expect, test, vi } from "vitest"
import type { ComposerFileReference, ComposerSessionReference } from "../../../../apps/daemon/src/composer-reference-protocol.ts"
import { buildComposerPrompt } from "./composer-prompt.ts"
import type { ComposerMention } from "./composer-mentions.ts"

const file: ComposerFileReference = {
  kind: "file", originId: "catalog", workspaceId: "10", directoryIndex: 1,
  sourceDirectory: "/source/api", relativePath: "src/app.ts",
}
const session: ComposerSessionReference = { kind: "session", originId: "catalog", workspaceId: "10", sessionId: "20" }
function mention(text: string, token: string, reference: ComposerMention["reference"]): ComposerMention {
  const start = text.indexOf(token)
  return { id: token, start, end: start + token.length, token, reference }
}
const skill = { kind: "skill" as const, id: "skill:review", name: "review", providerId: "pi-agent", invocation: "/skill:review" }

test("selected identities resolve against the newly created Session alongside attachments", async () => {
  const draft = "Compare @app with @previous"
  const resolved = [{ type: "resource_link" as const, uri: "file:///worktree/api/src/app.ts", name: "src/app.ts" }, { type: "text" as const, text: "Read Session 20 with deskfleet_session_history" }]
  const resolveReferences = vi.fn(async () => resolved)
  const content = await buildComposerPrompt({
    draft, mentions: [mention(draft, "@app", file), mention(draft, "@previous", session)],
    attachments: [{ id: "log", kind: "pasted_text", text: "logs", lines: 1 }],
    sessionId: "30", providerId: "codex", resolveReferences,
  })
  expect(resolveReferences).toHaveBeenCalledExactlyOnceWith("30", [file, session])
  expect(content).toEqual([
    { type: "resource", resource: { uri: "deskfleet://pasted-text/log.txt", mimeType: "text/plain", text: "logs" } },
    { type: "text", text: draft }, ...resolved,
  ])
})

test("editing a selected token leaves ordinary text without resolving its former identity", async () => {
  const original = "Read @app"
  const resolveReferences = vi.fn()
  expect(await buildComposerPrompt({ draft: "Read @apps", mentions: [mention(original, "@app", file)],
    attachments: [], sessionId: "30", providerId: "codex", resolveReferences,
  })).toEqual([{ type: "text", text: "Read @apps" }])
  expect(resolveReferences).not.toHaveBeenCalled()
})

test("native skills use the selected provider's invocation while preserving the draft", async () => {
  const draft = "$review check the API"
  const mentions = [mention(draft, "$review", skill)]
  expect(await buildComposerPrompt({ draft, mentions, attachments: [], sessionId: "30", providerId: "pi-agent", resolveReferences: vi.fn() }))
    .toEqual([{ type: "text", text: "/skill:review check the API" }])
  expect(mentions[0]?.token).toBe("$review")
  await expect(buildComposerPrompt({ draft, mentions, attachments: [], sessionId: "30", providerId: "another-agent", resolveReferences: vi.fn() }))
    .rejects.toThrow("current Agent")
  const moved = "Please $review"
  await expect(buildComposerPrompt({ draft: moved, mentions: [mention(moved, "$review", skill)], attachments: [], sessionId: "30", providerId: "pi-agent", resolveReferences: vi.fn() }))
    .rejects.toThrow("start of the message")
})

test("failed reference resolution preserves the draft and avoids starting attachment uploads", async () => {
  const uploadAttachment = vi.fn()
  const draft = "Read @app"
  const mentions = [mention(draft, "@app", file)]
  await expect(buildComposerPrompt({ draft, mentions, attachments: [{ id: "upload", kind: "local_file", name: "extra.txt", size: 1, bytes: new Uint8Array([1]) }],
    sessionId: "30", providerId: "codex", filesApi: { uploadAttachment } as never,
    resolveReferences: vi.fn(async () => { throw new Error("File missing from generated worktree") }),
  })).rejects.toThrow("generated worktree")
  expect(uploadAttachment).not.toHaveBeenCalled()
  expect(mentions[0]?.reference).toEqual(file)
})
