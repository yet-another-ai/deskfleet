import { expect, test } from "vitest"
import { shortenToolPath, toolCallSummary } from "./tool-call-summary.ts"

test("extracts and shortens file, move, execute, search, and fetch targets", () => {
  expect(toolCallSummary({ toolCallId: "r", kind: "read", rawInput: { file_path: "/Users/dev/session-worktrees/65/repo-0/src/App.vue" } }))
    .toEqual({ kind: "read", target: "src/App.vue" })
  expect(toolCallSummary({ toolCallId: "e", kind: "edit", locations: [{ path: "/repo/src/App.vue" }], content: [{ type: "diff", path: "src/App.vue", newText: "" }] }))
    .toEqual({ kind: "edit", target: "src/App.vue" })
  expect(toolCallSummary({ toolCallId: "d", kind: "delete", rawInput: { cwd: "/repo" }, locations: [{ path: "file:///repo/src/old.ts" }] }))
    .toEqual({ kind: "delete", target: "src/old.ts" })
  expect(toolCallSummary({ toolCallId: "m", kind: "move", rawInput: { cwd: "/repo", from: "/repo/a.ts", to: "/repo/b.ts" } }))
    .toEqual({ kind: "move", target: "a.ts → b.ts" })
  expect(toolCallSummary({ toolCallId: "x", kind: "execute", rawInput: { command: "/bin/zsh -lc \"rg --files src\"" } }))
    .toEqual({ kind: "execute", target: "rg --files src" })
  expect(toolCallSummary({ toolCallId: "s", kind: "search", rawInput: { cwd: "/repo", pattern: "AgentToolCall", path: "/repo/src" } }))
    .toEqual({ kind: "search", target: "AgentToolCall (src)" })
  expect(toolCallSummary({ toolCallId: "f", kind: "search", rawInput: { action: { type: "openPage", url: "https://example.com" } } }))
    .toEqual({ kind: "fetch", target: "https://example.com" })
  expect(toolCallSummary({ toolCallId: "u", title: "Read settings", rawInput: { path: "settings.json" } })).toBeUndefined()
  expect(shortenToolPath("/workspace/repo/src/index.ts", "/workspace/repo")).toBe("src/index.ts")
})
