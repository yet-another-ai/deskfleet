import { MUX_CHANNEL, MUX_CHANNEL_EVENT, type MuxChannelsApi } from "@deskfleet/client/mux-channels"
import { localChannelsApi } from "./local-channels.ts"

export function muxChannelsApi(): MuxChannelsApi {
  return localChannelsApi(MUX_CHANNEL, MUX_CHANNEL_EVENT)
}
