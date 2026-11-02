export interface SessionFace {
  id: string
  name: string
  email?: string | null
  active: boolean
}

/** People who have opened a Session. Whoever is here now comes first. */
export function sessionFaces(
  viewers: readonly { userId: string; seenAt: string }[] | undefined,
  activeIds: readonly string[],
  profile: (userId: string) => { name: string; email?: string | null },
): SessionFace[] {
  const active = new Set(activeIds)
  const seen = new Map<string, string>()
  for (const viewer of viewers ?? []) if (viewer.userId) seen.set(viewer.userId, viewer.seenAt)
  for (const userId of activeIds) if (userId && !seen.has(userId)) seen.set(userId, "9999")
  return [...seen].map(([userId, seenAt]) => {
    const person = profile(userId)
    return { id: userId, name: person.name, email: person.email, active: active.has(userId), seenAt }
  }).sort((left, right) => Number(right.active) - Number(left.active) || right.seenAt.localeCompare(left.seenAt) || left.name.localeCompare(right.name))
    .map(({ seenAt: _seenAt, ...face }) => face)
}
