import { configureClient } from "@deskfleet/client/platform"
import { centralBridgeClient } from "@deskfleet/client/central-bridge"
import { captureCentralRequestError, initializeErrorReporting } from "@deskfleet/components/services/error-reporting.ts"
import "virtual:uno.css"

const bridge = window.deskfleet.centralBridge
initializeErrorReporting("desktop", await bridge?.context().catch(() => undefined))
configureClient({ ...window.deskfleet, ...(bridge ? { central: centralBridgeClient(bridge, captureCentralRequestError) } : {}) })
const { mountDeskfleet } = await import("@deskfleet/components")
await mountDeskfleet()
