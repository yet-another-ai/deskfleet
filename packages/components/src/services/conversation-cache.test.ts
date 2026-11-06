import { expect, test, vi } from "vitest"
import { agentSnapshot } from "../test/agent.ts"
import { clearConversationOwner, createConversationCache } from "./conversation-cache.ts"

test("unavailable browser storage leaves conversation operations usable", async () => {
  vi.stubGlobal("indexedDB", undefined)
  try {
    const cache = createConversationCache("account", "team-machine")
    await expect(cache.read("30")).resolves.toBeUndefined()
    await expect(cache.write("30", { snapshot: agentSnapshot(), events: [] })).resolves.toBeUndefined()
    await expect(cache.remove("30")).resolves.toBeUndefined()
    await expect(cache.retain([])).resolves.toBeUndefined()
    await expect(clearConversationOwner("account")).resolves.toBeUndefined()
  } finally { vi.unstubAllGlobals() }
})
