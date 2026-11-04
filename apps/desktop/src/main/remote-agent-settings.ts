import { readRemoteAgentSettings, writeRemoteAgentSettings, type RemoteAgentSettings } from "../../../daemon/src/remote-agent-settings.ts"

export class RemoteAgentSettingsController {
  readonly #directory: string
  constructor(directory: string) { this.#directory = directory }
  get(): Promise<RemoteAgentSettings> { return readRemoteAgentSettings(this.#directory) }
  set(value: RemoteAgentSettings): Promise<RemoteAgentSettings> { return writeRemoteAgentSettings(this.#directory, value) }
}
