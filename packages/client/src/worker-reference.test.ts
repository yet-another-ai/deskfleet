import { describe, expect, it } from "vitest"
import { formatWorkerReference, parseWorkerReference } from "./worker-reference.ts"

describe("explicit Worker references", () => {
  const target = { teamId: "team-a", machineId: "mac-1", sessionId: "9007199254740993" }
  const token = formatWorkerReference(target)

  it("round-trips the scoped identifier as plain text without rounding the session ID", () => {
    expect(token).toBe("@worker[team-a/mac-1/9007199254740993]")
    expect(parseWorkerReference(`请让${token}复测\n保留  原样`)).toEqual({ target, text: "请让复测\n保留  原样" })
    const encoded = { teamId: "t/%", machineId: "机器[1]", sessionId: "01" }
    expect(parseWorkerReference(formatWorkerReference(encoded))?.target).toEqual(encoded)
  })

  it("ignores ordinary prose and accepts repeated mentions of the same Worker", () => {
    expect(parseWorkerReference("让 worker 2 检查一下，编号是 123")).toBeUndefined()
    expect(parseWorkerReference(`${token}\n${token}`)).toEqual({ target, text: "" })
  })

  it("rejects a truncated, damaged, or conflicting address", () => {
    for (const bad of ["@worker[a/b/c", "@worker[a//c]", "@worker[a/b/c/d]", "@worker[a/%00/c]", "@worker[a/b/%ff]", "@worker[a/b/c\n]"]) {
      expect(() => parseWorkerReference(bad)).toThrow()
    }
    expect(() => parseWorkerReference(`${token} @worker[team-b/mac-1/9007199254740993]`)).toThrow(/one Worker/)
  })
})
