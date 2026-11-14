import type { RequestTransport } from "./request-diagnostics.ts"

/** Backend links only need text messages and the standard WebSocket lifecycle. */
export type CentralSocket = Pick<WebSocket,
  "readyState" | "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose" | "addEventListener">

/** Hosts supply their networking stack; browser and headless clients use their globals. */
export interface CentralTransport {
  fetch?: typeof globalThis.fetch
  socket?: (url: string) => CentralSocket
  transport?: RequestTransport
}
