import {
  SA_ACCENT_DISTANCE_THRESHOLD,
  SA_ACCENT_OKLAB_DISTANCE_TABLE,
  SA_ACCENT_PALETTE,
  SA_ACCENT_RECENT_LIMIT,
  SA_ACCENT_SLOT_COUNT,
  type SuperTicketAccentPaletteEntry,
  type SuperTicketAccentThemeStyle,
} from "./super-agent-accent-data.ts"

export {
  SA_ACCENT_DISTANCE_THRESHOLD,
  SA_ACCENT_OKLAB_DISTANCE_TABLE,
  SA_ACCENT_PALETTE,
  SA_ACCENT_RECENT_LIMIT,
  SA_ACCENT_SLOT_COUNT,
  type SuperTicketAccentPaletteEntry,
  type SuperTicketAccentThemeStyle,
}

export function isValidAccentSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < SA_ACCENT_SLOT_COUNT
}

export function createEmptyAccentSlotCounts(): number[] {
  return Array.from({ length: SA_ACCENT_SLOT_COUNT }, () => 0)
}

/** Incrementally maintain up to 7 most recent distinct accent slots (MRU order, no history scan). */
export function recordRecentAccentSlotValue(recentSlots: readonly number[], slot: number): number[] {
  if (!isValidAccentSlot(slot)) return recentSlots.filter(isValidAccentSlot).slice(0, SA_ACCENT_RECENT_LIMIT)
  const next: number[] = [slot]
  for (let i = 0; i < recentSlots.length && next.length < SA_ACCENT_RECENT_LIMIT; i++) {
    const entry = recentSlots[i]
    if (isValidAccentSlot(entry) && entry !== slot && !next.includes(entry)) {
      next.push(entry)
    }
  }
  return next
}

/** Deterministic unsigned 32-bit tie-breaker hash for `(ticketId, slot)` (FNV-1a + Murmur3 fmix32). */
export function stableAccentHash(ticketId: string, slot: number): number {
  let hash = 0x811c9dc5 >>> 0
  for (let i = 0; i < ticketId.length; i++) {
    const code = ticketId.charCodeAt(i)
    hash ^= code & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
    if (code > 0xff) {
      hash ^= (code >>> 8) & 0xff
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  hash ^= 0x00
  hash = Math.imul(hash, 0x01000193) >>> 0
  hash ^= slot & 0xff
  hash = Math.imul(hash, 0x01000193) >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * Deterministic single-pass 48-slot color selector (no sorting).
 * Maximizes lexicographically: `(isFree, min(recentDist, T), -activeCount, stableAccentHash(ticketId, slot))`.
 * When `recentSlots` contains no valid entries, the second tuple element is `T`.
 */
export function selectTicketAccentSlot(
  ticketId: string,
  activeSlotCounts: readonly number[],
  recentSlots: readonly number[],
): number {
  let bestSlot = 0
  let bestIsFree = -1
  let bestDist = -1
  let bestNegCount = -Infinity
  let bestHash = -1

  for (let slot = 0; slot < SA_ACCENT_SLOT_COUNT; slot++) {
    const rawCount = activeSlotCounts[slot]
    const count = typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0
    const isFree = count === 0 ? 1 : 0

    let minDist = Infinity
    const distances = SA_ACCENT_OKLAB_DISTANCE_TABLE[slot]!
    for (let i = 0; i < recentSlots.length; i++) {
      const recent = recentSlots[i]
      if (!isValidAccentSlot(recent)) continue
      const d = distances[recent]!
      if (d < minDist) minDist = d
    }
    const clampedDist = minDist === Infinity
      ? SA_ACCENT_DISTANCE_THRESHOLD
      : Math.min(minDist, SA_ACCENT_DISTANCE_THRESHOLD)

    const negCount = -count
    const hash = stableAccentHash(ticketId, slot)

    const better =
      isFree !== bestIsFree ? isFree > bestIsFree :
      clampedDist !== bestDist ? clampedDist > bestDist :
      negCount !== bestNegCount ? negCount > bestNegCount :
      hash > bestHash

    if (better) {
      bestSlot = slot
      bestIsFree = isFree
      bestDist = clampedDist
      bestNegCount = negCount
      bestHash = hash
    }
  }

  return bestSlot
}

export interface AccentSlotTicketInput {
  id: string
  accentSlot?: number
  archiveState?: string
}

/**
 * Deterministically resolve a valid 48-slot accent for every ticket in a room using the exact
 * 48-color rule, without mutating or reordering any ticket that already holds a valid `accentSlot`.
 * Pass 1 preserves existing valid slots and counts active (unarchived) occupancy.
 * Pass 2 fills missing legacy slots in stored order so first open works without new messages or edits.
 */
export function resolveRoomTicketAccentSlots(
  tickets: readonly AccentSlotTicketInput[],
  initialRecentSlots: readonly number[] = [],
): Map<string, number> {
  const counts = createEmptyAccentSlotCounts()
  const resolved = new Map<string, number>()
  let recent = initialRecentSlots.filter(isValidAccentSlot).slice(0, SA_ACCENT_RECENT_LIMIT)

  for (const ticket of tickets) {
    if (!isValidAccentSlot(ticket.accentSlot)) continue
    resolved.set(ticket.id, ticket.accentSlot)
    if (!ticket.archiveState) {
      counts[ticket.accentSlot] = (counts[ticket.accentSlot] ?? 0) + 1
    }
  }

  for (const ticket of tickets) {
    if (resolved.has(ticket.id)) continue
    const slot = selectTicketAccentSlot(ticket.id, counts, recent)
    resolved.set(ticket.id, slot)
    if (!ticket.archiveState) {
      counts[slot] = (counts[slot] ?? 0) + 1
    }
    recent = recordRecentAccentSlotValue(recent, slot)
  }

  return resolved
}

function charDisplayWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || codePoint >= 0x1f300
  ) {
    return 2
  }
  return 1
}

/** Format a compact always-visible ticket short label (preserves full title in DOM `title` attribute). */
export function formatTicketShortLabel(title: string, maxCols = 16): string {
  const normalized = title.trim().replace(/\s+/gu, " ")
  if (!normalized) return ""
  let cols = 0
  let out = ""
  for (const ch of normalized) {
    const w = charDisplayWidth(ch.codePointAt(0) ?? 0)
    if (cols + w > maxCols) {
      return `${out.trimEnd()}…`
    }
    out += ch
    cols += w
  }
  return out
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex
  const n = Number.parseInt(clean, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function hexToOklab(hex: string): [number, number, number] {
  const [r8, g8, b8] = parseHexRgb(hex)
  const r = srgbToLinear(r8 / 255)
  const g = srgbToLinear(g8 / 255)
  const b = srgbToLinear(b8 / 255)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ]
}

export function oklabDistanceBetweenHex(hexA: string, hexB: string): number {
  const [l1, a1, b1] = hexToOklab(hexA)
  const [l2, a2, b2] = hexToOklab(hexB)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

export function wcagRelativeLuminance(hex: string): number {
  const [r8, g8, b8] = parseHexRgb(hex)
  return 0.2126 * srgbToLinear(r8 / 255) + 0.7152 * srgbToLinear(g8 / 255) + 0.0722 * srgbToLinear(b8 / 255)
}

export function wcagContrastRatio(hexA: string, hexB: string): number {
  const la = wcagRelativeLuminance(hexA)
  const lb = wcagRelativeLuminance(hexB)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
