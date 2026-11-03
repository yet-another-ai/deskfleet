import type { CentralApi } from "@deskfleet/client/central"
import { LOCAL_CHANNEL, LOCAL_CHANNEL_EVENT } from "@deskfleet/client/local-channels"
import { DaemonClient } from "./daemon-client.ts"
import { WindowLocalChannels, type LocalChannelAuthority } from "./local-channels-controller.ts"
import { installMessageChannels } from "./message-channels.ts"

export { invokeMessageChannels as invokeLocalChannels } from "./message-channels.ts"

export function installLocalChannels(central: LocalChannelAuthority & Pick<CentralApi, "onEvent">): { close(): Promise<void> } {
  return installMessageChannels(central, LOCAL_CHANNEL, LOCAL_CHANNEL_EVENT, emit =>
    new WindowLocalChannels(central, (event, disconnected) => DaemonClient.connect(event, disconnected), emit))
}
