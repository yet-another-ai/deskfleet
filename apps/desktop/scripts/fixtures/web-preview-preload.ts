import { contextBridge } from "electron"
import { webPreviewApi } from "../../src/preload/web-preview.ts"
import { isMainRendererUrl } from "../../src/shared/renderer-security.ts"

if (isMainRendererUrl(globalThis.location.href)) {
  contextBridge.exposeInMainWorld("deskfleet", {
    webPreview: webPreviewApi(),
  })
}
