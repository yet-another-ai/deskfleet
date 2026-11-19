import { describe, expect, test } from "vitest"
import {
  PERIODIC_TABLE_ELEMENTS,
  buildGeminiPeriodicEntries,
  extractGeminiVariantLabel,
  findGemini4ElementById,
  matchGemini4Element,
} from "./gemini-periodic-table.ts"

describe("gemini-periodic-table", () => {
  test("contains all 71 main-table elements across periods 1 to 6", () => {
    expect(PERIODIC_TABLE_ELEMENTS).toHaveLength(71)
    expect(PERIODIC_TABLE_ELEMENTS.find(el => el.symbol === "H")).toMatchObject({ number: 1, row: 1, col: 1 })
    expect(PERIODIC_TABLE_ELEMENTS.find(el => el.symbol === "C")).toMatchObject({ number: 6, row: 2, col: 14 })
    expect(PERIODIC_TABLE_ELEMENTS.find(el => el.symbol === "Ne")).toMatchObject({ number: 10, row: 2, col: 18 })
    expect(PERIODIC_TABLE_ELEMENTS.find(el => el.symbol === "Ar")).toMatchObject({ number: 18, row: 3, col: 18 })
    expect(PERIODIC_TABLE_ELEMENTS.find(el => el.symbol === "Rn")).toMatchObject({ number: 86, row: 6, col: 18 })
  })

  test("matches Gemini 4 models by element name across display names and IDs", () => {
    expect(matchGemini4Element({ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" })?.symbol).toBe("H")
    expect(matchGemini4Element({ id: "gemini-4-carbon", name: "Gemini 4 Carbon" })?.symbol).toBe("C")
    expect(matchGemini4Element({ id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" })?.symbol).toBe("Ne")
    expect(matchGemini4Element({ id: "gemini-4-argon", name: "Gemini 4 Argon" })?.symbol).toBe("Ar")
    expect(matchGemini4Element({ id: "gemini-4-krypton", name: "Gemini 4 Krypton" })?.symbol).toBe("Kr")
    expect(matchGemini4Element({ id: "gemini-4-aluminium", name: "Gemini 4 Aluminium" })?.symbol).toBe("Al")
    const uranium = matchGemini4Element({ id: "gemini-4-uranium", name: "Gemini 4 Uranium" })
    expect(uranium).toMatchObject({ number: 92, symbol: "U" })
    expect(uranium?.row).toBeUndefined()
  })

  test("ignores non-Gemini-4 models and non-element Gemini 4 names", () => {
    expect(matchGemini4Element({ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" })).toBeNull()
    expect(matchGemini4Element({ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" })).toBeNull()
    expect(matchGemini4Element({ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" })).toBeNull()
    expect(matchGemini4Element({ id: "gpt-5", name: "GPT-5" })).toBeNull()
    expect(matchGemini4Element({ id: "gemini-4-pro", name: "Gemini 4 Pro" })).toBeNull()
  })

  test("groups multi-variant element models and extracts readable variant labels", () => {
    const models = [
      { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", description: "Deeper reasoning." },
      { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)", description: "Faster responses." },
      { id: "gemini-4-argon", name: "Gemini 4 Argon", description: "Complex engineering." },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    ]
    const entries = buildGeminiPeriodicEntries(models)
    expect([...entries.keys()]).toEqual([10, 18])
    const neon = entries.get(10)!
    expect(neon.models.map(m => extractGeminiVariantLabel(m, neon.element))).toEqual(["High", "Low"])
    expect(findGemini4ElementById(models, "gemini-4-neon-high")?.symbol).toBe("Ne")
    expect(findGemini4ElementById(models, "claude-sonnet-4.5")).toBeNull()
    expect(findGemini4ElementById([], "gemini-4-carbon")?.symbol).toBe("C")
  })
})
