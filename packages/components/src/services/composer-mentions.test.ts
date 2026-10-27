import { expect, test } from "vitest"
import { commandDraft, composerTrigger, reconcileComposerMentions, validComposerMentions, type ComposerMention } from "./composer-mentions.ts"

const mention: ComposerMention = { id: "one", start: 5, end: 15, token: "@README.md", reference: { kind: "file", originId: "machine", workspaceId: "1", directoryIndex: 0, sourceDirectory: "/repo", relativePath: "README.md" } }
const original = "Read @README.md now"

test("completion triggers follow the cursor and leave ordinary symbols and noninitial slash text alone", () => {
  expect(composerTrigger("Read @readme later", 9)).toEqual({ kind: "reference", start: 5, end: 12, query: "rea" })
  expect(composerTrigger("$review", 7)?.kind).toBe("skill")
  expect(composerTrigger("  /comp", 7)?.kind).toBe("command")
  for (const value of ["email@example.com", "cost$20", "read /path", "https://example.com"]) expect(composerTrigger(value, value.length)).toBeNull()
  expect(composerTrigger(original, 10, [mention])).toBeNull()
})

test("selected references retain identity when text is inserted before or after them", () => {
  const prefixed = `Please ${original}`
  expect(reconcileComposerMentions(original, prefixed, [mention])).toEqual([{ ...mention, start: 12, end: 22 }])
  expect(reconcileComposerMentions(original, `${original}!`, [mention])).toEqual([mention])
  expect(reconcileComposerMentions(original, original.slice(5), [mention])).toEqual([{ ...mention, start: 0, end: 10 }])
})

test("editing or replacing a selected token removes its identity without reinterpreting typed mentions", () => {
  expect(reconcileComposerMentions(original, original.replace("README", "CHANGES"), [mention])).toEqual([])
  expect(reconcileComposerMentions(original, "New prompt @README.md", [mention])).toEqual([])
  expect(validComposerMentions(original, [{ ...mention, token: "@another" }])).toEqual([])
  expect(validComposerMentions(original, [mention, { ...mention, id: "overlapping" }])).toEqual([mention])
  const extended = original.replace("@README.md", "@README.mdx")
  expect(reconcileComposerMentions(original, extended, [mention])).toEqual([])
  expect(validComposerMentions(extended, [mention])).toEqual([])
  expect(validComposerMentions(original.replace("Read ", "Read-"), [mention])).toEqual([])
})

test("slash commands are identified only at the start of the prompt", () => {
  expect(commandDraft("  /compact use current changes")).toBe(true)
  expect(commandDraft("Explain /compact")).toBe(false)
  expect(commandDraft("/")).toBe(false)
})
