import { shell, type BrowserWindowConstructorOptions, type WebContents } from "electron"
import { isMainRendererUrl } from "../shared/renderer-security.ts"

/** Whether `url` targets a standalone preview route on the main renderer. */
export function isAuxiliaryRendererUrl(url: string): boolean {
  if (!isMainRendererUrl(url)) return false
  try {
    const hash = new URL(url).hash
    return hash.startsWith("#/mermaid") || hash.startsWith("#/preview")
  } catch {
    return false
  }
}

/** External links use the system browser; auxiliary previews use a renderer window. */
export function attachExternalLinks(
  contents: WebContents,
  auxiliaryWindowOptions?: () => BrowserWindowConstructorOptions,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      if (auxiliaryWindowOptions && isAuxiliaryRendererUrl(url)) {
        return { action: "allow", overrideBrowserWindowOptions: auxiliaryWindowOptions() }
      }
      const target = new URL(url)
      if (target.protocol === "https:" || target.protocol === "http:") {
        void shell.openExternal(target.href).catch(error => console.error("External link could not be opened", error))
      }
    } catch { /* Invalid URLs cannot be opened. */ }
    return { action: "deny" }
  })
}
