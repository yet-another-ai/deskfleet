import { shell, type BrowserWindowConstructorOptions, type WebContents } from "electron"
import { parseSessionWindowHash, type SessionWindowTarget } from "@deskfleet/client/session-window"
import { isMainRendererUrl } from "../shared/renderer-security.ts"

/** Parses a standalone Session window URL on the main renderer, if applicable. */
export function parseSessionWindowUrl(url: string): SessionWindowTarget | undefined {
  if (!isMainRendererUrl(url)) return undefined
  try {
    return parseSessionWindowHash(new URL(url).hash)
  } catch {
    return undefined
  }
}

/** Whether `url` targets a standalone preview or Session route on the main renderer. */
export function isAuxiliaryRendererUrl(url: string): boolean {
  if (!isMainRendererUrl(url)) return false
  try {
    const hash = new URL(url).hash
    return hash.startsWith("#/preview") || parseSessionWindowHash(hash) !== undefined
  } catch {
    return false
  }
}

/** External links use the system browser; auxiliary previews and Session views use renderer windows. */
export function attachExternalLinks(
  contents: WebContents,
  auxiliaryWindowOptions?: (url: string) => BrowserWindowConstructorOptions | null,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      if (auxiliaryWindowOptions && isAuxiliaryRendererUrl(url)) {
        const options = auxiliaryWindowOptions(url)
        return options ? { action: "allow", overrideBrowserWindowOptions: options } : { action: "deny" }
      }
      const target = new URL(url)
      if (target.protocol === "https:" || target.protocol === "http:") {
        void shell.openExternal(target.href).catch(error => console.error("External link could not be opened", error))
      }
    } catch { /* Invalid URLs cannot be opened. */ }
    return { action: "deny" }
  })
}
