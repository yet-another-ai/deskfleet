/**
 * The Gravatar image for an email address, at `size` device pixels. `d=404` makes an
 * address without a Gravatar fail to load, so callers keep their own fallback.
 */
export async function gravatarUrl(email: string, size: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()))
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  return `https://gravatar.com/avatar/${hash}?s=${size}&d=404`
}
