import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { browserClient } from "@deskfleet/client/browser"
import { configureClient } from "@deskfleet/client/platform"
import "virtual:uno.css"

const adapter = await browserClient(import.meta.env.VITE_DESKFLEET_SERVER_URL ?? (import.meta.env.DEV ? "http://localhost:8080" : location.origin))
configureClient(adapter)
if (location.pathname.startsWith("/auth/")) {
  const { mountAuthentication } = await import("@deskfleet/components/auth-mount.ts")
  await mountAuthentication(adapter.central as HttpCentralClient)
} else {
  const { mountDeskfleet } = await import("@deskfleet/components")
  await mountDeskfleet()
}
