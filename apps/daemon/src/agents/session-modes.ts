import type * as acp from "@agentclientprotocol/sdk/unstable"

interface SessionConfiguration {
  options?: acp.SessionConfigOption[] | null
  modes?: acp.SessionModeState | null
  currentModeId?: string
  modeRevision: number
}

type SessionResponse = Pick<acp.NewSessionResponse, "configOptions" | "modes">
const LEGACY_MODE = "deskfleet/sessionMode"

/** Keep a saved standalone mode when resume returns other options but omits `modes`. */
export function withRestoredSessionMode(live: acp.SessionConfigOption[], saved: acp.SessionConfigOption[]): acp.SessionConfigOption[] {
  if (live.some(option => option.category === "mode" || option.id === "mode")) return live
  const legacy = saved.find(option => option.id === "mode" && option.type === "select" && option._meta?.[LEGACY_MODE] === true)
  if (!legacy || legacy.type !== "select") return live
  // The saved current value describes the previous process, not this one.
  return [...live, { ...legacy, currentValue: "" }]
}

/** Projects advertised ACP session modes into the configuration used by DeskFleet. */
export class AcpSessionModes {
  readonly #sessions = new Map<string, SessionConfiguration>()

  #session(sessionId: string): SessionConfiguration {
    let state = this.#sessions.get(sessionId)
    if (!state) {
      state = { modeRevision: 0 }
      this.#sessions.set(sessionId, state)
    }
    return state
  }

  #usesLegacyMode(state: SessionConfiguration): boolean {
    if (!state.modes) return false
    const modes = state.modes.availableModes
    return !state.options?.some(option => {
      if (option.category === "mode" || option.id === "mode") return true
      // Pi also publishes its thinking levels as legacy modes. The thought
      // selector already owns that setting, including its confirmed updates.
      if (option.type !== "select" || option.category !== "thought_level") return false
      const choices = option.options.flatMap(value => "group" in value ? value.options : [value])
      return choices.length === modes.length && modes.every(mode => choices.some(choice => choice.value === mode.id))
    })
  }

  #options(state: SessionConfiguration): acp.SessionConfigOption[] | null | undefined {
    if (!this.#usesLegacyMode(state) || !state.modes) return state.options
    return [...state.options ?? [], {
      id: "mode", name: "Mode", category: "mode", type: "select",
      _meta: { [LEGACY_MODE]: true },
      currentValue: state.currentModeId ?? state.modes.currentModeId,
      options: state.modes.availableModes.map(mode => ({
        value: mode.id, name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    }]
  }

  #restoreModes(state: SessionConfiguration, knownOptions: acp.SessionConfigOption[] | undefined): void {
    if (state.modes != null) return
    // Live options that already advertise a mode own the setter. A model catalog
    // without modes is partial: the saved standalone mode still identifies set_mode.
    if (state.options?.some(option => option.category === "mode" || option.id === "mode")) return
    const mode = knownOptions?.find(option => option.id === "mode" && option._meta?.[LEGACY_MODE] === true)
    if (mode?.type !== "select") return
    if (state.options == null) state.options = knownOptions?.filter(option => option !== mode)
    state.modes = {
      // The saved catalog identifies the setter, but not this process's current mode.
      currentModeId: "",
      availableModes: mode.options.flatMap(option => "options" in option ? option.options : [option])
        .map(option => ({ id: option.value, name: option.name, description: option.description })),
    }
  }

  response<T extends SessionResponse>(sessionId: string, response: T): T {
    const state = this.#session(sessionId)
    if (response.configOptions !== undefined) state.options = response.configOptions
    if (response.modes !== undefined) {
      state.modes = response.modes
      state.currentModeId = response.modes?.currentModeId
    }
    const configOptions = this.#options(state)
    return configOptions === undefined ? response : { ...response, configOptions }
  }

  notification(notification: acp.SessionNotification): acp.SessionNotification {
    const { update, sessionId } = notification
    if (update.sessionUpdate !== "config_option_update" && update.sessionUpdate !== "current_mode_update") return notification
    const state = this.#session(sessionId)
    if (update.sessionUpdate === "config_option_update") {
      state.options = update.configOptions
    } else {
      state.currentModeId = update.currentModeId
      state.modeRevision++
      if (!this.#usesLegacyMode(state)) return notification
    }
    return { ...notification, update: { sessionUpdate: "config_option_update", configOptions: this.#options(state) ?? [] } }
  }

  async setConfigOption(
    params: acp.SetSessionConfigOptionRequest,
    setMode: (params: acp.SetSessionModeRequest) => Promise<acp.SetSessionModeResponse>,
    setOption: (params: acp.SetSessionConfigOptionRequest) => Promise<acp.SetSessionConfigOptionResponse>,
    knownOptions?: acp.SessionConfigOption[],
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const state = this.#session(params.sessionId)
    this.#restoreModes(state, knownOptions)
    if (params.configId !== "mode" || !this.#usesLegacyMode(state)) {
      return this.response(params.sessionId, await setOption(params))
    }
    if (typeof params.value !== "string" || !state.modes?.availableModes.some(mode => mode.id === params.value)) {
      throw new Error("The Agent does not offer this mode")
    }
    const revision = state.modeRevision
    await setMode({ sessionId: params.sessionId, modeId: params.value })
    // A notification can report an effective fallback while set_mode is pending.
    if (state.modeRevision === revision) state.currentModeId = params.value
    return { configOptions: this.#options(state) ?? [] }
  }
}
