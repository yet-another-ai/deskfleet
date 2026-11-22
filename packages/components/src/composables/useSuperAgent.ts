import { CentralRequestError, HttpError } from "@deskfleet/client/request-diagnostics"
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import type { SuperAgentConfig, SuperAgentHistory, SuperAgentMessage, SuperAgentMode, SuperAgentSession, SuperAgentTranscriptPart, SuperAgentTurn, SuperAgentUsage } from "@deskfleet/client/super-agent"
import { useDocumentVisibility, useTimeoutPoll } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue"
import type { ComposerAttachment } from "../services/composer-attachments.ts"
import { buildSuperAgentMessage } from "../services/super-agent-message.ts"
import { useAccountSession } from "./account-session-context.ts"

export function superAgentSessionKey(session: Pick<SuperAgentSession, "sessionId" | "engine" | "machineId">): string {
  return session.engine === "byoa" ? `byoa:${session.machineId ?? ""}:${session.sessionId}` : `hosted:${session.sessionId}`
}

export function useSuperAgent() {
  const account = useAccountSession()
  const automatic = account && withCentralRequestTrigger(account.central, "background")
  const user = account && withCentralRequestTrigger(account.central, "user")
  const visibility = useDocumentVisibility()
  const config = shallowRef<SuperAgentConfig>()
  const sessions = shallowRef<SuperAgentSession[]>([])
  const selectedKey = ref<string>()
  const usage = shallowRef<SuperAgentUsage>()
  const messages = shallowRef<SuperAgentMessage[]>([])
  const turns = shallowRef<SuperAgentTurn[]>([])
  const previews = shallowRef<SuperAgentHistory["previews"]>()
  const status = ref<SuperAgentHistory["status"]>()
  const pending = shallowRef<SuperAgentMessage[]>([])
  const draft = ref("")
  const attachments = shallowRef<ComposerAttachment[]>([])
  const loadingConfig = ref(false)
  const loadingList = ref(false)
  const loadingHistory = ref(false)
  const sending = ref(false)
  const configError = shallowRef<unknown>()
  const listError = shallowRef<unknown>()
  const usageError = shallowRef<unknown>()
  const readError = shallowRef<unknown>()
  const sendError = shallowRef<unknown>()
  const cancelError = shallowRef<unknown>()
  const cancellingId = ref<string>()

  const selectedSession = computed(() => selectedKey.value
    ? sessions.value.find(session => superAgentSessionKey(session) === selectedKey.value)
    : undefined)
  const selected = computed(() => selectedSession.value?.sessionId)
  const activeEngine = computed<SuperAgentMode>(() => selectedSession.value?.engine ?? config.value?.mode ?? "hosted")
  const isHostedSelected = computed(() => !!selectedSession.value && (selectedSession.value.engine ?? "hosted") === "hosted")
  const activeTurn = computed(() => turns.value.findLast(turn => turn.state === "running"))
  const cancelling = computed(() => !!cancellingId.value && cancellingId.value === activeTurn.value?.id)
  const canCancel = computed(() => isHostedSelected.value && !!activeTurn.value && !cancelling.value && !sending.value && !loadingHistory.value && !readError.value && status.value !== "ended")
  const canSend = computed(() => activeEngine.value === "hosted" && !!account?.superAgentEnabled.value && !!usage.value?.admitted && !loadingList.value && !listError.value && !loadingHistory.value
    && !readError.value && !sending.value && status.value !== "ended")
  const title = computed(() => selectedSession.value?.title)

  let scopeRevision = 0
  let sessionRevision = 0
  let nextIndex = 0
  let pendingSenders: SuperAgentHistory["pendingSenders"]
  let reading = false
  // A poll can observe a rejection before the concurrent POST returns its delivery ID.
  const rejectedDuringSend = new Set<string>()
  const sentDrafts = new Map<string, { text: string; attachments: ComposerAttachment[] }>()
  let createOperation: string | undefined
  let delivery: { text: string; attachments: ComposerAttachment[]; operationId: string } | undefined

  function checkGate(error: unknown): void {
    const code = error instanceof HttpError ? error.code : error instanceof CentralRequestError ? error.diagnostics.apiErrorCode : undefined
    if (code === "super_agent_disabled") {
      void account?.refreshSuperAgentAvailability()
    }
  }

  async function refreshConfig(): Promise<void> {
    const teamId = account?.teamId.value
    if (!teamId || !automatic) return
    const revision = scopeRevision
    loadingConfig.value = true
    try {
      const result = await automatic.superAgentConfig(teamId)
      if (revision !== scopeRevision) return
      config.value = result
      configError.value = undefined
    } catch (error) {
      if (revision !== scopeRevision) return
      checkGate(error)
      configError.value = error
    } finally {
      if (revision === scopeRevision) loadingConfig.value = false
    }
  }

  function applyConfig(next: SuperAgentConfig): void {
    config.value = next
    configError.value = undefined
    if (next.mode === "hosted") void refreshUsage()
  }

  async function refreshUsage(): Promise<void> {
    const teamId = account?.teamId.value
    if (!teamId || !automatic) return
    const revision = scopeRevision
    try {
      const result = await automatic.superAgentUsage(teamId)
      if (revision !== scopeRevision) return
      usage.value = result
      usageError.value = undefined
    } catch (error) {
      if (revision !== scopeRevision) return
      checkGate(error)
      usageError.value = error
    }
  }

  async function readHistory(): Promise<void> {
    const teamId = account?.teamId.value
    const current = selectedSession.value
    if (!teamId || !current || (current.engine ?? "hosted") !== "hosted" || !automatic || reading) return
    const sessionId = current.sessionId
    const revision = sessionRevision
    reading = true
    try {
      const page = previews.value?.length
        ? await automatic.superAgentHistory(teamId, sessionId, nextIndex, pendingSenders, previews.value)
        : await automatic.superAgentHistory(teamId, sessionId, nextIndex, pendingSenders)
      if (revision !== sessionRevision) return
      nextIndex = page.nextIndex
      pendingSenders = page.pendingSenders
      previews.value = page.previews
      if (page.turns?.length) {
        const byId = new Map(turns.value.map(turn => [turn.id, turn]))
        for (const turn of page.turns) byId.set(turn.id, { ...byId.get(turn.id), ...turn })
        turns.value = [...byId.values()]
      }
      if (page.messages.length) {
        const byId = new Map(messages.value.map(message => [message.id, message]))
        for (const message of page.messages) {
          byId.set(message.id, message)
          if (message.role === "user") sentDrafts.delete(message.id)
        }
        messages.value = [...byId.values()]
        pending.value = pending.value.filter(message => !byId.has(message.id))
      }
      if (page.undeliveredIds?.length) {
        const rejected = new Set(page.undeliveredIds)
        if (sending.value) for (const id of rejected) rejectedDuringSend.add(id)
        const retry = pending.value.findLast(message => rejected.has(message.id))
        const original = retry && sentDrafts.get(retry.id)
        if (original && !draft.value && !attachments.value.length) {
          draft.value = original.text
          attachments.value = original.attachments
        }
        for (const id of rejected) sentDrafts.delete(id)
        pending.value = pending.value.filter(message => !rejected.has(message.id))
      }
      if (page.status) {
        const finished = status.value === "working" && page.status !== "working"
        status.value = page.status
        if (finished) void refreshUsage()
      }
      readError.value = undefined
    } catch (error) {
      if (revision !== sessionRevision) return
      checkGate(error)
      readError.value = error
    } finally {
      if (revision === sessionRevision) {
        reading = false
        loadingHistory.value = false
      }
    }
  }

  const poll = useTimeoutPoll(readHistory, () => pending.value.length || status.value === "working" ? 1500 : 10_000, { immediate: false })
  watch(() => isHostedSelected.value && !loadingHistory.value && !readError.value && status.value !== "ended" && visibility.value === "visible", active => {
    if (active) poll.resume()
    else poll.pause()
  })
  watch(visibility, active => {
    if (active !== "visible" || !account?.superAgentEnabled.value) return
    void refreshUsage()
    if (isHostedSelected.value && status.value !== "ended") void readHistory()
  })

  function resetSession(key?: string, isHosted = false): void {
    ++sessionRevision
    poll.pause()
    selectedKey.value = key
    messages.value = []
    turns.value = []
    previews.value = undefined
    pending.value = []
    status.value = undefined
    readError.value = undefined
    sendError.value = undefined
    cancelError.value = undefined
    cancellingId.value = undefined
    draft.value = ""
    attachments.value = []
    rejectedDuringSend.clear()
    sentDrafts.clear()
    createOperation = undefined
    delivery = undefined
    reading = false
    nextIndex = 0
    pendingSenders = undefined
    loadingHistory.value = isHosted
  }

  function select(target?: string | SuperAgentSession): void {
    if (sending.value) return
    if (!target) {
      if (selectedKey.value !== undefined) resetSession(undefined, false)
      return
    }
    const session = typeof target === "string"
      ? sessions.value.find(item => superAgentSessionKey(item) === target || item.sessionId === target)
      : target
    const key = session ? superAgentSessionKey(session) : `hosted:${target}`
    if (key === selectedKey.value) return
    const hosted = (session?.engine ?? "hosted") === "hosted"
    resetSession(key, hosted)
    if (hosted) void readHistory()
  }

  function upsertSession(session: SuperAgentSession, selectIt = false): void {
    const key = superAgentSessionKey(session)
    sessions.value = [session, ...sessions.value.filter(item => superAgentSessionKey(item) !== key)]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    if (selectIt) selectedKey.value = key
  }

  async function loadSessions(): Promise<void> {
    const teamId = account?.teamId.value
    if (!teamId || !automatic) return
    const revision = scopeRevision
    loadingList.value = true
    try {
      const result = await automatic.superAgentSessions(teamId)
      if (revision !== scopeRevision) return
      sessions.value = result
      listError.value = undefined
      if (!selectedKey.value && result[0]) select(result[0])
    } catch (error) {
      if (revision !== scopeRevision) return
      checkGate(error)
      listError.value = error
    } finally {
      if (revision === scopeRevision) loadingList.value = false
    }
  }

  async function send(): Promise<void> {
    const teamId = account?.teamId.value
    const senderId = account?.account.value.user?.id
    const text = draft.value.trim()
    const files = attachments.value
    if (!teamId || !user || (!text && !files.length) || !canSend.value) return
    const revision = scopeRevision
    rejectedDuringSend.clear()
    sending.value = true
    sendError.value = undefined
    try {
      const content = buildSuperAgentMessage(text, files)
      let sessionId = isHostedSelected.value ? selectedSession.value?.sessionId : undefined
      if (!sessionId) {
        createOperation ??= crypto.randomUUID()
        const created = await user.createSuperAgentSession(teamId, createOperation)
        if (revision !== scopeRevision) return
        sessionId = created.sessionId
        const createdSession: SuperAgentSession = { sessionId, title: null, lastActiveAt: Date.now(), engine: "hosted" }
        upsertSession(createdSession, true)
      }
      if (delivery?.text !== text || delivery.attachments !== files) delivery = { text, attachments: files, operationId: crypto.randomUUID() }
      const { deliveryId } = await user.sendSuperAgentMessage(teamId, sessionId, delivery.operationId, content)
      if (revision !== scopeRevision) return
      delivery = undefined
      const rejected = rejectedDuringSend.has(deliveryId)
      if (!rejected) {
        if (draft.value.trim() === text) draft.value = ""
        if (attachments.value === files) attachments.value = []
      }
      const current = sessions.value.find(session => session.sessionId === sessionId && (session.engine ?? "hosted") === "hosted")
      const firstText = typeof content === "string" ? content : content.filter(part => part.type === "text").find(part => part.text.trim())?.text
      const nextTitle = current?.title ?? (firstText ? [...(firstText.trim().split("\n", 1)[0] ?? "")].slice(0, 80).join("") : null)
      upsertSession({ sessionId, title: nextTitle, lastActiveAt: Date.now(), engine: "hosted" })
      if (!rejected && !messages.value.some(message => message.id === deliveryId)) {
        if (status.value === "failed") status.value = undefined
        const parts: SuperAgentTranscriptPart[] | undefined = typeof content === "string" ? undefined : content.map(part => part.type === "text"
          ? { kind: "text", text: part.text }
          : { kind: "file", mediaType: part.mediaType, filename: part.filename })
        sentDrafts.set(deliveryId, { text, attachments: files })
        pending.value = [...pending.value, { id: deliveryId, role: "user", text, at: new Date().toISOString(), senderId, parts }]
      }
      await readHistory()
      // An idle shared conversation polls less frequently. Pick up the reply promptly after a send.
      if (revision === scopeRevision && !readError.value && visibility.value === "visible" && status.value !== "ended") {
        poll.pause()
        poll.resume()
      }
    } catch (error) {
      if (revision !== scopeRevision) return
      checkGate(error)
      sendError.value = error
      if (error instanceof CentralRequestError && error.diagnostics.status === 429) void refreshUsage()
    } finally {
      if (revision === scopeRevision) sending.value = false
    }
  }

  async function cancel(): Promise<void> {
    const teamId = account?.teamId.value
    const sessionId = selected.value
    const turnId = activeTurn.value?.id
    if (!teamId || !sessionId || !turnId || !user || !canCancel.value) return
    const revision = sessionRevision
    cancellingId.value = turnId
    cancelError.value = undefined
    try {
      await user.cancelSuperAgentTurn(teamId, sessionId, turnId)
      if (revision === sessionRevision) await readHistory()
    } catch (error) {
      if (revision !== sessionRevision) return
      checkGate(error)
      cancellingId.value = undefined
      cancelError.value = error
    }
  }

  watch([() => account?.account.value.serverUrl, () => account?.account.value.user?.id, () => account?.teamId.value, () => account?.superAgentEnabled.value], () => {
    ++scopeRevision
    resetSession()
    config.value = undefined
    configError.value = undefined
    loadingConfig.value = false
    sessions.value = []
    usage.value = undefined
    usageError.value = undefined
    listError.value = undefined
    loadingList.value = false
    sending.value = false
    if (account?.superAgentEnabled.value) {
      void refreshConfig()
      void loadSessions()
      void refreshUsage()
    }
  }, { immediate: true, flush: "sync" })

  onScopeDispose(() => { ++scopeRevision; ++sessionRevision })
  return {
    config, loadingConfig, configError, refreshConfig, applyConfig,
    sessions, selected, selectedKey, selectedSession, activeEngine, title, usage, messages, turns, previews, status, pending, draft, attachments,
    loadingList, loadingHistory, sending, canSend, canCancel, cancelling, listError, usageError, readError, sendError, cancelError,
    loadSessions, readHistory, refreshUsage, select, upsertSession, send, cancel,
  }
}
