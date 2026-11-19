import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"

const adapter = readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8").replace(/\r\n/gu, "\n")

type Tier = { id: string; name: string; description: string }
type Option = { id: string; name: string; description: string; type: string; currentValue: unknown; options?: { value: string; name: string }[] }
interface ServiceTiers {
  modelServiceTiers(model: unknown): Tier[]
  serviceTierFromThread(tier: string | null | undefined): string | null
  resolveServiceTier(selected: string | null, tiers: Tier[]): string | null
  serviceTierFromConfigValue(value: unknown, tiers: Tier[]): string | null | undefined
  createFastModeConfigOption(selected: string | null, tiers: Tier[], useBooleanConfigOption?: boolean): Option | null
}

const moduleStart = adapter.indexOf("// src/FastModeConfig.ts")
const moduleEnd = adapter.indexOf("// src/JBUtils.ts", moduleStart)
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "Pinned adapter fast mode module exists")
// The adapter exports only its executable. Run its real service-tier module, as in the other adapter tests.
const tiers = runInNewContext(`${adapter.slice(moduleStart, moduleEnd)}
({ modelServiceTiers, serviceTierFromThread, resolveServiceTier, serviceTierFromConfigValue, createFastModeConfigOption })`) as ServiceTiers

// Shapes reported by `codex app-server` 0.170 `model/list`.
const fastTier = { id: "priority", name: "Fast", description: "2x speed, increased usage" }
const ultrafastTier = { id: "ultrafast", name: "Ultrafast", description: "The fastest available responses for latency-sensitive work." }
const ultrafastModel = { additionalSpeedTiers: ["fast", "ultrafast"], serviceTiers: [fastTier, ultrafastTier] }
const fastModel = { additionalSpeedTiers: ["fast"], serviceTiers: [fastTier] }
const legacyFastModel = { additionalSpeedTiers: ["fast"] }
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

test("Codex models expose their catalog service tiers, falling back to legacy speed tiers", () => {
  assert.deepEqual(plain(tiers.modelServiceTiers(ultrafastModel)), [fastTier, ultrafastTier])
  assert.deepEqual(plain(tiers.modelServiceTiers(legacyFastModel).map(tier => tier.id)), ["fast"])
  assert.deepEqual(plain(tiers.modelServiceTiers({ additionalSpeedTiers: [], serviceTiers: [] })), [])
  assert.deepEqual(plain(tiers.modelServiceTiers(undefined)), [])
})

test("a model with several tiers offers Standard and every tier as a select, even to boolean clients", () => {
  const option = tiers.createFastModeConfigOption("ultrafast", tiers.modelServiceTiers(ultrafastModel), true)!
  assert.equal(option.id, "fast-mode")
  assert.equal(option.type, "select")
  assert.equal(option.currentValue, "ultrafast")
  assert.deepEqual(plain(option.options!.map(choice => [choice.value, choice.name])), [["off", "Standard"], ["priority", "Fast"], ["ultrafast", "Ultrafast"]])
  assert.equal(tiers.createFastModeConfigOption(null, tiers.modelServiceTiers(ultrafastModel), true)!.currentValue, "off")
  assert.equal(tiers.createFastModeConfigOption("fast", tiers.modelServiceTiers(ultrafastModel), true)!.currentValue, "priority")
})

test("a Fast-only model keeps the existing Fast mode toggle", () => {
  const fastOnly = tiers.modelServiceTiers(fastModel)
  const toggle = tiers.createFastModeConfigOption("priority", fastOnly, true)!
  assert.deepEqual([toggle.id, toggle.type, toggle.currentValue], ["fast-mode", "boolean", true])
  assert.equal(tiers.createFastModeConfigOption("fast", tiers.modelServiceTiers(legacyFastModel), true)!.currentValue, true)
  assert.equal(tiers.createFastModeConfigOption("ultrafast", fastOnly, true)!.currentValue, false)
  const select = tiers.createFastModeConfigOption("priority", fastOnly, false)!
  assert.equal(select.currentValue, "on")
  assert.deepEqual(plain(select.options!.map(choice => choice.value)), ["off", "on"])
  assert.equal(tiers.createFastModeConfigOption(null, [], true), null)
})

test("a thread's reported tier restores the selection and turns send only tiers the model offers", () => {
  assert.equal(tiers.serviceTierFromThread("default"), null)
  assert.equal(tiers.serviceTierFromThread(null), null)
  assert.equal(tiers.serviceTierFromThread("priority"), "priority")
  assert.equal(tiers.serviceTierFromThread("ultrafast"), "ultrafast")
  const multi = tiers.modelServiceTiers(ultrafastModel)
  assert.equal(tiers.resolveServiceTier("ultrafast", multi), "ultrafast")
  assert.equal(tiers.resolveServiceTier("fast", multi), "priority")
  assert.equal(tiers.resolveServiceTier("ultrafast", tiers.modelServiceTiers(fastModel)), null)
  assert.equal(tiers.resolveServiceTier("priority", tiers.modelServiceTiers(legacyFastModel)), "fast")
  assert.equal(tiers.resolveServiceTier(null, multi), null)
})

test("config values select a tier the current model offers and reject anything else", () => {
  const multi = tiers.modelServiceTiers(ultrafastModel)
  const fastOnly = tiers.modelServiceTiers(fastModel)
  assert.equal(tiers.serviceTierFromConfigValue(true, fastOnly), "priority")
  assert.equal(tiers.serviceTierFromConfigValue(false, fastOnly), null)
  assert.equal(tiers.serviceTierFromConfigValue("on", fastOnly), "priority")
  assert.equal(tiers.serviceTierFromConfigValue("off", multi), null)
  assert.equal(tiers.serviceTierFromConfigValue("ultrafast", multi), "ultrafast")
  assert.equal(tiers.serviceTierFromConfigValue("priority", multi), "priority")
  for (const invalid of ["ultrafast", "bogus", 1, null]) {
    assert.equal(tiers.serviceTierFromConfigValue(invalid, fastOnly), undefined)
  }
})

test("sessions and prompts use the selected service tier instead of the Fast flag", () => {
  assert.doesNotMatch(adapter, /fastModeEnabled|currentModelSupportsFast|resolveFastServiceTier/u)
  assert.match(adapter, /serviceTier: serviceTierFromThread\(sessionMetadata\.currentServiceTier\),\n\s+serviceTiers,/u)
  assert.match(adapter, /const serviceTier = resolveServiceTier\(\n?\s*sessionState\.serviceTier,\n?\s*sessionState\.serviceTiers\n?\s*\);/u)
})
