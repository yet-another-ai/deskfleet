import { CentralRequestError, HttpError } from "@deskfleet/client/request-diagnostics"
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import type { SuperAgentHistory, SuperAgentMessage, SuperAgentSession, SuperAgentUsage } from "@deskfleet/client/super-agent"
import { useDocumentVisibility, useTimeoutPoll } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue"
import { useAccountSession } from "./account-session-context.ts"

export function useSuperAgent() {
  const account = useAccountSession()
  const automatic = account && withCentralRequestTrigger(account.central, "background")
  const user = account && withCentralRequestTrigger(account.central, "user")
  const visibility = useDocumentVisibility()
  const sessions = shallowRef<SuperAgentSession[]>([])
  const selected = ref<string>()
  const usage = shallowRef<SuperAgentUsage>()
  const messages = shallowRef<SuperAgentMessage[]>([])
  const status = ref<SuperAgentHistory["status"]>()
  const pending = shallowRef<SuperAgentMessage[]>([])
  const draft = ref("")
  const loadingList = ref(false)
  const loadingHistory = ref(false)
  const sending = ref(false)
  const listError = shallowRef<unknown>()
  const usageError = shallowRef<unknown>()
  const readError = shallowRef<unknown>()
  const sendError = shallowRef<unknown>()
  const canSend = computed(() => !!account?.superAgentEnabled.value && !!usage.value?.admitted && !loadingList.value && !listError.value && !loadingHistory.value
    && !readError.value && !sending.value && status.value !== "ended")
  const title = computed(() => sessions.value.find(session => session.sessionId === selected.value)?.title)
  let scopeRevision = 0
  let sessionRevision = 0
  let nextIndex = 0
  let pendingSenders: SuperAgentHistory["pendingSenders"]
  let reading = false
  // A poll can observe a rejection before the concurrent POST returns its delivery ID.
  const rejectedDuringSend = new Set<string>()
  let createOperation: string | undefined
  let delivery: { text: string; operationId: string } | undefined

  function checkGate(error: unknown): void {
    const code = error instanceof HttpError ? error.code : error instanceof CentralRequestError ? error.diagnostics.apiErrorCode : undefined
    if (code === "super_agent_disabled") {
      void account?.refreshSuperAgentAvailability()
    }
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
    const sessionId = selected.value
    if (!teamId || !sessionId || !automatic || reading) return
    const revision = sessionRevision
    reading = true
    try {
      const page = await automatic.superAgentHistory(teamId, sessionId, nextIndex, pendingSenders)
      if (revision !== sessionRevision) return
      nextIndex = page.nextIndex
      pendingSenders = page.pendingSenders
      if (page.messages.length) {
        const byId = new Map(messages.value.map(message => [message.id, message]))
        for (const message of page.messages) byId.set(message.id, message)
        messages.value = [...byId.values()]
        pending.value = pending.value.filter(message => !byId.has(message.id))
      }
      if (page.undeliveredIds?.length) {
        const rejected = new Set(page.undeliveredIds)
        if (sending.value) for (const id of rejected) rejectedDuringSend.add(id)
        const retry = pending.value.findLast(message => rejected.has(message.id))
        if (retry && !draft.value) draft.value = retry.text
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
  watch(() => !!selected.value && !loadingHistory.value && !readError.value && status.value !== "ended" && visibility.value === "visible", active => {
    if (active) poll.resume()
    else poll.pause()
  })
  watch(visibility, active => {
    if (active !== "visible" || !account?.superAgentEnabled.value) return
    void refreshUsage()
    if (selected.value && status.value !== "ended") void readHistory()
  })

  function resetSession(id?: string): void {
    ++sessionRevision
    poll.pause()
    selected.value = id
    messages.value = []
    pending.value = []
    status.value = undefined
    readError.value = undefined
    sendError.value = undefined
    draft.value = ""
    rejectedDuringSend.clear()
    createOperation = undefined
    delivery = undefined
    reading = false
    nextIndex = 0
    pendingSenders = undefined
    loadingHistory.value = !!id
  }
  function select(id?: string): void {
    if (sending.value || id === selected.value) return
    resetSession(id)
    if (id) void readHistory()
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
      if (!selected.value && result[0]) select(result[0].sessionId)
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
    if (!teamId || !user || !text || !canSend.value) return
    const revision = scopeRevision
    rejectedDuringSend.clear()
    sending.value = true
    sendError.value = undefined
    try {
      let sessionId = selected.value
      if (!sessionId) {
        createOperation ??= crypto.randomUUID()
        const created = await user.createSuperAgentSession(teamId, createOperation)
        if (revision !== scopeRevision) return
        sessionId = created.sessionId
        selected.value = sessionId
        sessions.value = [{ sessionId, title: null, lastActiveAt: Date.now() }, ...sessions.value]
      }
      if (delivery?.text !== text) delivery = { text, operationId: crypto.randomUUID() }
      const { deliveryId } = await user.sendSuperAgentMessage(teamId, sessionId, delivery.operationId, text)
      if (revision !== scopeRevision) return
      delivery = undefined
      const rejected = rejectedDuringSend.has(deliveryId)
      if (!rejected) draft.value = ""
      const current = sessions.value.find(session => session.sessionId === sessionId)
      const title = current?.title ?? [...(text.split("\n", 1)[0] ?? "")].slice(0, 80).join("")
      sessions.value = [{ sessionId, title, lastActiveAt: Date.now() }, ...sessions.value.filter(session => session.sessionId !== sessionId)]
      if (!rejected && !messages.value.some(message => message.id === deliveryId)) {
        if (status.value === "failed") status.value = undefined
        pending.value = [...pending.value, { id: deliveryId, role: "user", text, at: new Date().toISOString(), senderId }]
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

  watch([() => account?.account.value.serverUrl, () => account?.account.value.user?.id, () => account?.teamId.value, () => account?.superAgentEnabled.value], () => {
    ++scopeRevision
    resetSession()
    sessions.value = []
    usage.value = undefined
    usageError.value = undefined
    listError.value = undefined
    loadingList.value = false
    sending.value = false
    if (account?.superAgentEnabled.value) {
      void loadSessions()
      void refreshUsage()
    }
  }, { immediate: true, flush: "sync" })

  onScopeDispose(() => { ++scopeRevision; ++sessionRevision })
  return { sessions, selected, title, usage, messages, status, pending, draft, loadingList, loadingHistory, sending, canSend,
    listError, usageError, readError, sendError, loadSessions, readHistory, refreshUsage, select, send }
}
