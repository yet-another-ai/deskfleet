/**
 * The Gravatar image for an email address, at `size` device pixels. `d=404` makes an
 * address without a Gravatar fail the probe, so callers keep their own placeholder.
 */
export async function gravatarUrl(email: string, size: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()))
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  return `https://gravatar.com/avatar/${hash}?s=${size}&d=404`
}

/** Resolve when `url` loads as an image. Reject when the image is missing or unreachable. */
function probeImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.referrerPolicy = "no-referrer"
    image.onload = () => resolve()
    image.onerror = () => reject(new Error("gravatar image missing"))
    image.src = url
  })
}

/**
 * The image URL when this address has a Gravatar. A missing or unreachable image is absent.
 *
 * Probes with an image element so the request uses `img-src`, which already allows Gravatar.
 * A `fetch` probe would need `connect-src` and trip the Electron renderer's closed network policy.
 */
export async function loadGravatar(email: string, size: number): Promise<string | undefined> {
  try {
    const url = await gravatarUrl(email, size)
    await probeImage(url)
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
