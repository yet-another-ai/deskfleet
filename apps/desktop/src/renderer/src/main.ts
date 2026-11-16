import { configureClient } from "@deskfleet/client/platform"
import { centralBridgeClient } from "@deskfleet/client/central-bridge"
import { captureCentralRequestError, initializeErrorReporting } from "@deskfleet/components/services/error-reporting.ts"
import { filesBridgeClient } from "../../shared/files-bridge.ts"
import "virtual:uno.css"

const bridge = window.deskfleet.centralBridge
initializeErrorReporting("desktop", await bridge?.context().catch(() => undefined))
configureClient({
  ...window.deskfleet,
  files: window.deskfleet.files ? filesBridgeClient(window.deskfleet.files) : undefined,
  ...(bridge ? { central: centralBridgeClient(bridge, captureCentralRequestError) } : {}),
})
const { mountDeskfleet } = await import("@deskfleet/components")
await mountDeskfleet()
