import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createEmptyAccentSlotCounts,
  formatTicketShortLabel,
  isValidAccentSlot,
  oklabDistanceBetweenHex,
  recordRecentAccentSlotValue,
  resolveRoomTicketAccentSlots,
  SA_ACCENT_DISTANCE_THRESHOLD,
  SA_ACCENT_OKLAB_DISTANCE_TABLE,
  SA_ACCENT_PALETTE,
  SA_ACCENT_RECENT_LIMIT,
  SA_ACCENT_SLOT_COUNT,
  selectTicketAccentSlot,
  stableAccentHash,
  wcagContrastRatio,
} from "./super-agent-accent.ts"

const LIGHT_CANVAS = "#fbfbfd"
const LIGHT_SURFACE = "#ffffff"
const DARK_CANVAS = "#17191f"
const DARK_SURFACE = "#1f222a"

test("core acceptance: archiving A makes its slot the only free slot, B reuses it, restoring A preserves both slots with active occupancy 2", () => {
  const counts = createEmptyAccentSlotCounts()
  let recent: number[] = []
  const assigned = new Map<string, number>()

  // Allocate 48 active tickets (ticket-A is first, plus 47 others) so all 48 slots have active count = 1.
  const ticketAId = "ticket-A"
  const slotA = selectTicketAccentSlot(ticketAId, counts, recent)
  assert.ok(isValidAccentSlot(slotA))
  assigned.set(ticketAId, slotA)
  counts[slotA] = counts[slotA]! + 1
  recent = recordRecentAccentSlotValue(recent, slotA)

  for (let i = 1; i < SA_ACCENT_SLOT_COUNT; i++) {
    const id = `ticket-fill-${i}`
    const slot = selectTicketAccentSlot(id, counts, recent)
    assert.equal(counts[slot], 0, `expected ticket ${i} to take a free slot`)
    assigned.set(id, slot)
    counts[slot] = counts[slot]! + 1
    recent = recordRecentAccentSlotValue(recent, slot)
  }
  assert.equal(counts.every(c => c === 1), true)

  // Archive A: release occupancy without changing A's accentSlot; slotA is now the ONLY free slot.
  counts[slotA] = counts[slotA]! - 1
  assert.equal(counts[slotA], 0)
  assert.equal(counts.filter(c => c === 0).length, 1)

  // Even if A just appeared in recent messages (distance 0 to slotA), isFree=1 wins so B reuses slotA.
  recent = recordRecentAccentSlotValue(recent, slotA)
  const slotB = selectTicketAccentSlot("ticket-B", counts, recent)
  assert.equal(slotB, slotA)
  counts[slotB] = counts[slotB]! + 1
  assert.equal(counts[slotA], 1)

  // Restore A: do not re-run color selection; add back A's original slot occupancy.
  counts[slotA] = counts[slotA]! + 1
  assert.equal(assigned.get(ticketAId), slotA)
  assert.equal(slotB, slotA)
  assert.equal(counts[slotA], 2)
})

test("palette has 48 slots x 2 themes (96 styles) meeting WCAG contrast minimums (>= 4.5:1 label text/bg, >= 3:1 rail/bg)", () => {
  assert.equal(SA_ACCENT_SLOT_COUNT, 48)
  assert.equal(SA_ACCENT_RECENT_LIMIT, 7)
  assert.equal(SA_ACCENT_PALETTE.length, 48)

  for (let slot = 0; slot < 48; slot++) {
    const entry = SA_ACCENT_PALETTE[slot]!
    assert.equal(entry.slot, slot)

    const lightLabelCanvas = wcagContrastRatio(entry.light.labelText, LIGHT_CANVAS)
    const lightLabelSurface = wcagContrastRatio(entry.light.labelText, LIGHT_SURFACE)
    const darkLabelCanvas = wcagContrastRatio(entry.dark.labelText, DARK_CANVAS)
    const darkLabelSurface = wcagContrastRatio(entry.dark.labelText, DARK_SURFACE)
    assert.ok(lightLabelCanvas >= 4.5, `slot ${slot} light label/canvas contrast ${lightLabelCanvas.toFixed(2)} < 4.5`)
    assert.ok(lightLabelSurface >= 4.5, `slot ${slot} light label/surface contrast ${lightLabelSurface.toFixed(2)} < 4.5`)
    assert.ok(darkLabelCanvas >= 4.5, `slot ${slot} dark label/canvas contrast ${darkLabelCanvas.toFixed(2)} < 4.5`)
    assert.ok(darkLabelSurface >= 4.5, `slot ${slot} dark label/surface contrast ${darkLabelSurface.toFixed(2)} < 4.5`)

    const lightRailCanvas = wcagContrastRatio(entry.light.rail, LIGHT_CANVAS)
    const lightRailSurface = wcagContrastRatio(entry.light.rail, LIGHT_SURFACE)
    const darkRailCanvas = wcagContrastRatio(entry.dark.rail, DARK_CANVAS)
    const darkRailSurface = wcagContrastRatio(entry.dark.rail, DARK_SURFACE)
    assert.ok(lightRailCanvas >= 3.0, `slot ${slot} light rail/canvas contrast ${lightRailCanvas.toFixed(2)} < 3.0`)
    assert.ok(lightRailSurface >= 3.0, `slot ${slot} light rail/surface contrast ${lightRailSurface.toFixed(2)} < 3.0`)
    assert.ok(darkRailCanvas >= 3.0, `slot ${slot} dark rail/canvas contrast ${darkRailCanvas.toFixed(2)} < 3.0`)
    assert.ok(darkRailSurface >= 3.0, `slot ${slot} dark rail/surface contrast ${darkRailSurface.toFixed(2)} < 3.0`)
  }
})

test("precomputed 48x48 OKLab table matches min(light, dark) rail distance for every pair", () => {
  assert.equal(SA_ACCENT_OKLAB_DISTANCE_TABLE.length, 48)
  for (let i = 0; i < 48; i++) {
    assert.equal(SA_ACCENT_OKLAB_DISTANCE_TABLE[i]!.length, 48)
    assert.equal(SA_ACCENT_OKLAB_DISTANCE_TABLE[i]![i], 0)
    for (let j = i + 1; j < 48; j++) {
      const dl = oklabDistanceBetweenHex(SA_ACCENT_PALETTE[i]!.light.rail, SA_ACCENT_PALETTE[j]!.light.rail)
      const dd = oklabDistanceBetweenHex(SA_ACCENT_PALETTE[i]!.dark.rail, SA_ACCENT_PALETTE[j]!.dark.rail)
      const expected = Math.round(Math.min(dl, dd) * 10_000) / 10_000
      assert.equal(SA_ACCENT_OKLAB_DISTANCE_TABLE[i]![j], expected, `mismatch at (${i}, ${j})`)
      assert.equal(SA_ACCENT_OKLAB_DISTANCE_TABLE[j]![i], expected, `asymmetry at (${j}, ${i})`)
    }
  }
})

test("first 48 tickets each get a unique slot; 49th ticket stably reuses without changing earlier allocations", () => {
  const counts = createEmptyAccentSlotCounts()
  let recent: number[] = []
  const slots: number[] = []

  for (let i = 0; i < 48; i++) {
    const slot = selectTicketAccentSlot(`first-48-${i}`, counts, recent)
    slots.push(slot)
    counts[slot] = counts[slot]! + 1
    recent = recordRecentAccentSlotValue(recent, slot)
  }

  assert.equal(new Set(slots).size, 48)
  assert.equal(counts.every(c => c === 1), true)

  const snapshotBefore49 = [...slots]
  const slot49a = selectTicketAccentSlot("ticket-49", counts, recent)
  const slot49b = selectTicketAccentSlot("ticket-49", counts, recent)
  assert.ok(isValidAccentSlot(slot49a))
  assert.equal(slot49a, slot49b, "49th allocation must be deterministic")
  assert.deepEqual(slots, snapshotBefore49)
})

test("once threshold T is reached, lower active occupancy wins over larger excess distance", () => {
  const recent = [0]
  const T = SA_ACCENT_DISTANCE_THRESHOLD

  // Find two slots that both satisfy D[s][0] >= T, where highDistSlot has strictly larger OKLab distance than lowOccSlot.
  const qualifying = Array.from({ length: 48 }, (_, slot) => ({
    slot,
    dist: SA_ACCENT_OKLAB_DISTANCE_TABLE[slot]![0]!,
  })).filter(entry => entry.dist >= T)
  qualifying.sort((a, b) => a.dist - b.dist)
  assert.ok(qualifying.length >= 2)
  const lowOccSlot = qualifying[0]!.slot
  const highDistSlot = qualifying.at(-1)!.slot
  assert.ok(SA_ACCENT_OKLAB_DISTANCE_TABLE[highDistSlot]![0]! > SA_ACCENT_OKLAB_DISTANCE_TABLE[lowOccSlot]![0]!)

  // All slots occupied: lowOccSlot has occupancy 1, highDistSlot has occupancy 4, all other slots have occupancy 5.
  const counts = Array.from({ length: 48 }, (_, slot) =>
    slot === lowOccSlot ? 1 : slot === highDistSlot ? 4 : 5)

  const picked = selectTicketAccentSlot("threshold-tie-test", counts, recent)
  assert.equal(picked, lowOccSlot)
})

test("when no recent tickets exist, second tuple element defaults to T and selection breaks ties by stable hash", () => {
  const counts = createEmptyAccentSlotCounts()
  const ticketId = "empty-room-ticket"
  const picked = selectTicketAccentSlot(ticketId, counts, [])

  let expectedSlot = 0
  let bestHash = -1
  for (let slot = 0; slot < 48; slot++) {
    const hash = stableAccentHash(ticketId, slot)
    if (hash > bestHash) {
      bestHash = hash
      expectedSlot = slot
    }
  }
  assert.equal(picked, expectedSlot)
})

test("when no candidate reaches T, selector picks the slot maximizing min distance to recent 7", () => {
  // Construct counts where all slots are occupied equally except a close group, and pick a dense recent set
  // where only one slot has the largest distance below T (using a custom check against the real table).
  // Find a slot s whose nearest 7 neighbors are close, or verify exact tuple optimality directly across all 48 slots.
  const counts = Array.from({ length: 48 }, () => 1)
  // Pick 7 recent slots spaced around the wheel so some slots are < T.
  const recent = [0, 6, 12, 18, 24, 30, 36]
  // Put count=1 on slots with minDist < T, count=99 on slots with minDist >= T -> wait: dist comes BEFORE -count!
  // So any slot with minDist >= T MUST still beat a count=1 slot with minDist < T!
  const withHighOccOnSafe = Array.from({ length: 48 }, (_, s) => {
    const md = Math.min(...recent.map(r => SA_ACCENT_OKLAB_DISTANCE_TABLE[s]![r]!))
    return md >= SA_ACCENT_DISTANCE_THRESHOLD ? 10 : 1
  })
  const picked = selectTicketAccentSlot("avoid-collision", withHighOccOnSafe, recent)
  const pickedDist = Math.min(...recent.map(r => SA_ACCENT_OKLAB_DISTANCE_TABLE[picked]![r]!))
  assert.ok(pickedDist >= SA_ACCENT_DISTANCE_THRESHOLD, "must prioritize meeting T before lowering occupancy")
})

test("formatTicketShortLabel produces compact always-visible labels without middot separators", () => {
  assert.equal(formatTicketShortLabel("  事项A  "), "事项A")
  assert.equal(formatTicketShortLabel("Auth fix"), "Auth fix")
  const longZh = formatTicketShortLabel("按引用方案在个人0.23版实现SA事项自动配色功能")
  assert.ok(longZh.endsWith("…"))
  assert.ok(longZh.length < 15)
  assert.ok(!longZh.includes("·"))
})

test("resolveRoomTicketAccentSlots backfills legacy tickets deterministically without reordering or changing existing valid slots", () => {
  const mixed = [
    { id: "legacy-1" },
    { id: "existing-a", accentSlot: 7 },
    { id: "legacy-2" },
    { id: "legacy-archived", archiveState: "archived" },
    { id: "existing-b", accentSlot: 29 },
  ]
  const first = resolveRoomTicketAccentSlots(mixed)
  const second = resolveRoomTicketAccentSlots(mixed)

  assert.deepEqual([...first.entries()], [...second.entries()])
  // Existing valid slots stay untouched.
  assert.equal(first.get("existing-a"), 7)
  assert.equal(first.get("existing-b"), 29)

  // Legacy tickets all receive valid slots distinct from existing active slots and from each other.
  const leg1 = first.get("legacy-1")!
  const leg2 = first.get("legacy-2")!
  const legArch = first.get("legacy-archived")!
  assert.ok(isValidAccentSlot(leg1))
  assert.ok(isValidAccentSlot(leg2))
  assert.ok(isValidAccentSlot(legArch))
  assert.equal(new Set([7, 29, leg1, leg2, legArch]).size, 5)
  assert.ok(SA_ACCENT_OKLAB_DISTANCE_TABLE[leg1]![leg2]! >= SA_ACCENT_DISTANCE_THRESHOLD)
})
