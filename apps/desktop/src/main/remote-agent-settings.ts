import type { RemoteAgentSettings } from "@deskfleet/protocol/remote-agent-settings"
import { readRemoteAgentSettings, writeRemoteAgentSettings } from "@deskfleet/daemon/host-settings"

export class RemoteAgentSettingsController {
  readonly #directory: string
  constructor(directory: string) { this.#directory = directory }
  get(): Promise<RemoteAgentSettings> { return readRemoteAgentSettings(this.#directory) }
  set(value: RemoteAgentSettings): Promise<RemoteAgentSettings> { return writeRemoteAgentSettings(this.#directory, value) }
}
