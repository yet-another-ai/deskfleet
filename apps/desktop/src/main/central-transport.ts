import { net } from "electron"
import type { CentralSocket, CentralTransport } from "@deskfleet/client/central-transport"

/** Use Chromium's system proxy/PAC and trust settings for both desktop backend links. */
export const desktopCentralTransport: CentralTransport = {
  fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, { ...init, credentials: "omit" }),
  transport: "electron_net",
  // Electron implements WHATWG events, but its generated declarations type the
  // on* properties as Function rather than the standard event-handler signatures.
  socket: url => new net.WebSocket(url, { useSessionCookies: false }) as CentralSocket,
}
