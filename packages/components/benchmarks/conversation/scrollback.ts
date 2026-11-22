interface LocateTarget {
  rowIndex: number
  entryId: string
  select(entryId: string | undefined): Promise<void>
}

interface ScrollbackOptions {
  locate?: LocateTarget
  checkpoint?(name: "top" | "middle" | "bottom" | "located-thought"): Promise<void>
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
async function painted() {
  await frame()
  await frame()
  // Intersection callbacks and Vue updates follow the rendering step.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}
function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Scrollback verification: ${message}`)
}

function disclosureKey(button: HTMLButtonElement): string | undefined {
  if (button.hasAttribute("data-turn-work")) return "work"
  if (button.hasAttribute("data-activity-trigger")) return `activity:${button.closest<HTMLElement>("[data-activity-group]")?.dataset.activityGroup}`
  const kind = button.classList.contains("group/thought") ? "thought" : button.classList.contains("group/tool") ? "tool" : undefined
  return kind && `${kind}:${button.closest<HTMLElement>("[data-conversation-entry]")?.dataset.conversationEntry}`
}

function disclosures(row: HTMLElement) {
  return [...row.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].flatMap(button => {
    const key = disclosureKey(button)
    return key ? [{ key, button, open: button.getAttribute("aria-expanded") === "true" }] : []
  })
}

function visibleText(target: HTMLElement, scroller: HTMLElement, label: string, alignment: "start" | "center" = "start"): string {
  // Check skipped rendering before geometry/text reads can force the subtree to render.
  require(target.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }), `${label} is still skipped or hidden after two frames`)
  const content = target.querySelector<HTMLElement>(".ui-markdown") ?? target.firstElementChild
  require(content?.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }), `${label} has skipped descendants`)
  const bounds = target.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
  const top = Math.max(bounds.top, viewport.top), bottom = Math.min(bounds.bottom, viewport.bottom)
  const left = Math.max(bounds.left, viewport.left), right = Math.min(bounds.right, viewport.right)
  require(bottom - top > 2 && right - left > 2, `${label} missed the viewport`)
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
  if (alignment === "start") {
    require(Math.abs(bounds.top - viewport.top) <= 64 || (atEnd && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom + 1), `${label} scroll anchor moved away from the viewport start`)
  } else {
    const midpoint = (bounds.top + bounds.bottom) / 2, viewportMidpoint = (viewport.top + viewport.bottom) / 2
    const clampedStart = scroller.scrollTop <= 1 && bounds.top >= viewport.top && midpoint <= viewportMidpoint
    const clampedEnd = atEnd && bounds.bottom <= viewport.bottom + 1 && midpoint >= viewportMidpoint
    require(Math.abs(midpoint - viewportMidpoint) <= 64 || clampedStart || clampedEnd, `${label} scroll anchor moved away from the viewport center`)
  }
  const hit = document.elementFromPoint((left + right) / 2, Math.min(bottom - 1, top + 8))
  require(hit && target.contains(hit), `${label} has no hit-testable content at its visible position`)
  const text = target.innerText.trim()
  require(text.length > 0, `${label} has no rendered text`)
  return text.slice(0, 120)
}

function scrollPosition(target: HTMLElement, scroller: HTMLElement) {
  const targetBounds = target.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
  return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, viewportTop: viewport.top, viewportBottom: viewport.bottom, targetTop: targetBounds.top, targetBottom: targetBounds.bottom }
}

function visibleNeighbors(rows: HTMLElement[], index: number, scroller: HTMLElement): number[] {
  const viewport = scroller.getBoundingClientRect()
  const visible: number[] = []
  for (let candidate = Math.max(0, index - 1); candidate <= Math.min(rows.length - 1, index + 1); candidate++) {
    const row = rows[candidate]!, bounds = row.getBoundingClientRect()
    if (Math.min(bounds.bottom, viewport.bottom) - Math.max(bounds.top, viewport.top) <= 2) continue
    require(row.querySelector(".ui-markdown, [data-user-message-bubble]")?.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }), `visible neighbor row ${candidate} is still skipped`)
    const hit = document.elementFromPoint((bounds.left + bounds.right) / 2, Math.max(bounds.top, viewport.top) + 1)
    require(hit && row.contains(hit) && hit !== row, `visible neighbor row ${candidate} has no hit-testable descendants`)
    visible.push(candidate)
  }
  return visible
}

/** Run only after timing/DOM diagnostics; these reads deliberately exercise real layout. */
export async function verifyConversationScrollback(scroller: HTMLElement, conversation: HTMLElement, options: ScrollbackOptions = {}) {
  const rows = [...conversation.querySelectorAll<HTMLElement>(":scope > div > ol > li")]
  require(rows.length >= 2, "expected an input and a completed response")
  const originalScrollTop = scroller.scrollTop
  const wasAtBottom = originalScrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
  const disclosureState = (row: HTMLElement) => disclosures(row).map(({ key, open }) => ({ key, open }))
  let topMarkdown: Element | null = null
  let recycledMarkdown = false
  let topDisclosures: ReturnType<typeof disclosureState> = []
  const latestMarkdown = rows.at(-1)!.querySelector<HTMLElement>(".ui-markdown")
  require(latestMarkdown && latestMarkdown.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }), "latest completed answer is skipped while viewing history")
  const visits: Array<{ position: string; rowIndex: number; readyMs: number; text: string; visibleRows: number[] }> = []
  let locate: { entryId: string; readyMs: number; text: string } | undefined
  let touchedRow: HTMLElement | undefined
  let originalDisclosures: ReturnType<typeof disclosureState> = []

  async function restoreRow(row: HTMLElement, expected: Array<{ key: string; open: boolean }>) {
    // Reopening an outer disclosure mounts fresh inner buttons. Restore from
    // logical entry IDs, rather than stale element references/ARIA-generated IDs.
    for (const prefix of ["work", "activity:", "thought:", "tool:"]) {
      for (const item of expected.filter(item => item.key.startsWith(prefix))) {
        const current = disclosures(row).find(candidate => candidate.key === item.key)
        require(current, `missing disclosure ${item.key} while restoring`)
        if (current.open !== item.open) current.button.click()
      }
      await painted()
    }
  }

  performance.mark("conversation-scrollback-start")
  try {
    const positions = [{ name: "top", index: 0 }, ...(rows.length > 2 ? [{ name: "middle", index: Math.floor(rows.length / 2) }] : []), { name: "bottom", index: rows.length - 1 }] as const
    for (const position of positions) {
      const row = rows[position.index]!
      const before = scrollPosition(row, scroller)
      const started = performance.now()
      row.scrollIntoView({ block: "start", behavior: "instant" })
      const scrollTopImmediately = scroller.scrollTop
      await painted()
      let text: string
      try { text = visibleText(row, scroller, position.name) }
      catch (error) { throw new Error(`${String(error)}; ${JSON.stringify({ rowIndex: position.index, before, scrollTopImmediately, afterTwoFrames: scrollPosition(row, scroller) })}`) }
      if (position.name === "top") {
        topMarkdown = rows[1]!.querySelector(".ui-markdown")
        require(topMarkdown, "first answer Markdown did not mount")
        topDisclosures = disclosureState(rows[1]!)
      }
      const visibleRows = visibleNeighbors(rows, position.index, scroller)
      visits.push({ position: position.name, rowIndex: position.index, readyMs: performance.now() - started, text, visibleRows })
      await options.checkpoint?.(position.name as "top" | "middle" | "bottom")
    }
    recycledMarkdown = topMarkdown?.isConnected === false && !rows[1]!.querySelector(".ui-markdown")
    if (rows.length >= 42) require(recycledMarkdown, "first answer Markdown remained mounted at the bottom of a long transcript")
    require(latestMarkdown.isConnected, "scrolling replaced the latest completed answer")
    rows[0]!.scrollIntoView({ block: "start", behavior: "instant" })
    await painted()
    require(rows[1]!.querySelector(".ui-markdown"), "first answer Markdown did not remount")
    require(JSON.stringify(disclosureState(rows[1]!)) === JSON.stringify(topDisclosures), "scrolling changed first response disclosure state")

    if (options.locate) {
      const target = options.locate
      const row = rows[target.rowIndex]
      require(row, "locate target row is absent")
      touchedRow = row
      row.scrollIntoView({ block: "start", behavior: "instant" })
      await painted()
      originalDisclosures = disclosureState(row)
      const work = row.querySelector<HTMLButtonElement>("[data-turn-work]")
      require(work, "locate target has no work disclosure")
      if (work.getAttribute("aria-expanded") !== "true") { work.click(); await painted() }
      const activity = row.querySelector<HTMLButtonElement>("[data-activity-trigger]")
      require(activity, "locate target has no nested activity disclosure")
      const activityWasOpen = activity.getAttribute("aria-expanded") === "true"
      if (activityWasOpen) { activity.click(); await painted() }
      work.click()
      await painted()
      rows.at(-1)!.scrollIntoView({ block: "start", behavior: "instant" })
      await painted()
      const started = performance.now()
      await target.select(target.entryId)
      await painted()
      const entry = row.querySelector<HTMLElement>(`[data-conversation-entry="${CSS.escape(target.entryId)}"]`)
      require(entry, "locating a collapsed thought did not open its ancestors")
      require(row.querySelector("[data-turn-work]")?.getAttribute("aria-expanded") === "true" && row.querySelector("[data-activity-trigger]")?.getAttribute("aria-expanded") === "true", "locate left an ancestor collapsed")
      entry.scrollIntoView({ block: "center", behavior: "instant" })
      await painted()
      const text = visibleText(entry, scroller, "located thought", "center")
      visibleNeighbors(rows, target.rowIndex, scroller)
      require(entry.querySelector(".ui-markdown"), "located thought Markdown is missing")
      locate = { entryId: target.entryId, readyMs: performance.now() - started, text }
      await options.checkpoint?.("located-thought")
      await target.select(undefined)
      // If work was originally closed its nested state was absent from the
      // snapshot; restore the state observed when it was first opened above.
      if (!originalDisclosures.some(item => item.key.startsWith("activity:"))) {
        const restoredActivity = row.querySelector<HTMLButtonElement>("[data-activity-trigger]")!
        if ((restoredActivity.getAttribute("aria-expanded") === "true") !== activityWasOpen) restoredActivity.click()
        await painted()
      }
    }
  } finally {
    await options.locate?.select(undefined)
    if (touchedRow) {
      await restoreRow(touchedRow, originalDisclosures)
      require(JSON.stringify(disclosureState(touchedRow)) === JSON.stringify(originalDisclosures), "verification did not restore disclosure state")
    }
    scroller.scrollTo({ top: wasAtBottom ? scroller.scrollHeight : originalScrollTop, behavior: "instant" })
    await painted()
    performance.mark("conversation-scrollback-ready")
  }
  require(rows.every(row => row.isConnected), "scrolling replaced a row anchor")
  return { latestCompletedRenderable: true, recycledMarkdown, disclosureStateRestored: true, visits, locate }
}
