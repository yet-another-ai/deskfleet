/**
 * Cap for auto-generated Session and Terminal titles shown in tabs.
 * User renames keep a separate, larger RPC limit (200); defaults from first
 * messages, provider updates, commands, and OSC titles use this tighter bound.
 */
export const MAX_GENERATED_TITLE_LENGTH = 40

/** Trim and clamp a generated title to {@link MAX_GENERATED_TITLE_LENGTH} UTF-16 code units. */
export function truncateGeneratedTitle(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_GENERATED_TITLE_LENGTH) return trimmed
  return trimmed.slice(0, MAX_GENERATED_TITLE_LENGTH)
}
