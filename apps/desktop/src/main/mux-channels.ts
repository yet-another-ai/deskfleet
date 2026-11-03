import type { CentralApi } from "@deskfleet/client/central"
import { getMachineMux } from "@deskfleet/client/mux-client"
import { MUX_CHANNEL, MUX_CHANNEL_EVENT } from "@deskfleet/client/mux-channels"
import { installMessageChannels } from "./message-channels.ts"
import { WindowMuxChannels } from "./mux-channels-controller.ts"
import { nativeMuxPeer } from "./mux-peer.ts"

export function installMuxChannels(central: CentralApi): { close(): Promise<void> } {
  const pool = getMachineMux(central, nativeMuxPeer)
  const bridge = installMessageChannels(central, MUX_CHANNEL, MUX_CHANNEL_EVENT, emit =>
    new WindowMuxChannels(request => pool.open(request, request.purpose), emit))
  return {
    async close() { await bridge.close(); await pool.close() },
  }
}
