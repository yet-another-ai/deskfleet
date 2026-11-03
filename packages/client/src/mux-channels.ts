import type { LocalChannelsApi } from "./local-channels.ts"

export const MUX_CHANNEL = "deskfleet:mux-channels"
export const MUX_CHANNEL_EVENT = "deskfleet:mux-channel-event"

/** Main owns the shared remote peer; each renderer document owns its logical streams. */
export type MuxChannelsApi = LocalChannelsApi
