import { configureClient } from "@deskfleet/client/platform"
import "virtual:uno.css"

configureClient(window.deskfleet)
const { mountDeskfleet } = await import("@deskfleet/components")
mountDeskfleet()
