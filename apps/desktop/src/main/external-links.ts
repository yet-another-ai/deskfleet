import { shell, type WebContents } from "electron"

/** External links use the system browser; the app never creates another renderer. */
export function attachExternalLinks(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === "https:" || target.protocol === "http:") {
        void shell.openExternal(target.href).catch(error => console.error("External link could not be opened", error))
      }
    } catch { /* Invalid URLs cannot be opened. */ }
    return { action: "deny" }
  })
}
