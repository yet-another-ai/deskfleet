import { configureClient } from "@deskfleet/client/platform"
import { initializeErrorReporting } from "@deskfleet/components/services/error-reporting.ts"
import "virtual:uno.css"

initializeErrorReporting("desktop")
configureClient(window.deskfleet)
const { mountDeskfleet } = await import("@deskfleet/components")
await mountDeskfleet()
