import { browserClient } from "@deskfleet/client/browser"
import { configureClient } from "@deskfleet/client/platform"
import "virtual:uno.css"

const adapter = await browserClient(import.meta.env.VITE_DESKFLEET_SERVER_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:8080" : location.origin))
configureClient(adapter)
const { mountDeskfleet } = await import("@deskfleet/components")
await mountDeskfleet()
