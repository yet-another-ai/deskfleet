/**
 * The Gravatar image for an email address, at `size` device pixels. `d=404` makes an
 * address without a Gravatar fail the probe, so callers keep their own placeholder.
 */
export async function gravatarUrl(email: string, size: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()))
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  return `https://gravatar.com/avatar/${hash}?s=${size}&d=404`
}

/** The image URL when this address has a Gravatar. A missing or unreachable image is absent. */
export async function loadGravatar(email: string, size: number): Promise<string | undefined> {
  try {
    const url = await gravatarUrl(email, size)
    const response = await fetch(url)
    const type = response.headers.get("content-type") ?? ""
    // A 404 page is not an avatar. Never hand it to an image element.
    if (!response.ok || !type.startsWith("image/")) return undefined
    return url
  } catch {
    return undefined
  }
}

/** One or two letters from a person's name, for the placeholder shown when they have no photo. */
export function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean)
  const first = parts[0]
  if (!first) return "?"
  const last = parts.length > 1 ? parts.at(-1) : undefined
  return (first.charAt(0) + (last?.charAt(0) ?? "")).toLocaleUpperCase()
}
