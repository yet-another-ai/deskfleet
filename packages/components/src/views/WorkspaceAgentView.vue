<script setup lang="ts">
import { Archive, ArrowDown, ArrowRight, ChevronDown, ChevronRight, ClipboardList, CornerUpLeft, Focus, Folder, MapPin, MessagesSquare, X } from "@lucide/vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import { useDocumentVisibility, useOnline, useResizeObserver, useTimeoutFn } from "@vueuse/core"
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRoute, useRouter } from "vue-router"
import type { GithubRepositoryItem } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { extractSaVisibleMarkers, isValidAccentSlot, resolveRoomTicketAccentSlots, type FollowUpRunRecord, type SuperFeedbackItem, type SuperMessage, type SuperTicket, type SuperWorkerRequest, type SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import { enableTakeoverOnMachine } from "../services/workspace-agent-follow-up.ts"
import ConfirmDialog from "../components/common/ConfirmDialog.vue"
import GithubIcon from "../components/common/GithubIcon.vue"
import GithubPanel from "../components/details/GithubPanel.vue"
import { withGithubReference } from "../services/github-composer-reference.ts"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import SpringSurface from "../components/common/SpringSurface.ts"
import UiScrollArea from "../components/common/UiScrollArea.vue"
import AgentContent from "../components/session/AgentContent.vue"
import AgentMessageActions from "../components/session/AgentMessageActions.vue"
import AgentOutline from "../components/session/AgentOutline.vue"
import ReadingSpotlight from "../components/session/ReadingSpotlight.vue"
import { scrollSpring, type SpringScroll } from "../services/spring-scroll.ts"
import { useConversationReadingStore } from "../stores/conversation-reading.ts"
import UiButton from "../components/common/UiButton.vue"
import UiDialog from "../components/common/UiDialog.vue"
import ProjectModelMenu from "../components/composer/ProjectModelMenu.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import WorkspaceProgressDetails from "../components/session/WorkspaceProgressDetails.vue"
import WorkspaceReEditBanner from "../components/session/WorkspaceReEditBanner.vue"
import WorkspaceReplyProgress from "../components/session/WorkspaceReplyProgress.vue"
import WorkspaceStoppedActions from "../components/session/WorkspaceStoppedActions.vue"
import WorkspaceWorkerRequest from "../components/session/WorkspaceWorkerRequest.vue"
import WorkspaceMessage from "../components/session/WorkspaceMessage.vue"
import WorkspaceMessageQuote from "../components/session/WorkspaceMessageQuote.vue"
import "../styles/sa-ticket-accents.css"
import { useFileTarget, useTranscriptFileTarget } from "../composables/useFileTarget.ts"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { useConnectionResume } from "../composables/useConnectionResume.ts"
import { useWorkspaceAgentDisplayName } from "../composables/useWorkspaceAgentDisplayName.ts"
import { useWorkspaceAgentSummary } from "../composables/useWorkspaceAgentSummary.ts"
import { useWorkspaceConversation } from "../composables/useWorkspaceConversation.ts"
import { buildWorkspaceTranscript, filterFeedbackForFocusedTicket, filterProgressForFocusedTicket, filterWorkspaceRowsByTicket, hasTicketStatus, indexWorkspaceTranscriptLocateTargets, missingWorker, previousUserMessageId, resolveWorkspaceStoppedTurns, stoppableSteps, workerSummary, workspaceMessageRows, type TranscriptEntry, type WorkspaceLocateTarget, type WorkspaceReplyProgress as ReplyProgress, type WorkspaceRow } from "../services/workspace-message-timeline.ts"
import { workspaceAgentRoute, workspaceSessionRoute } from "../services/workspace-agent-navigation.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useProvidersStore } from "../stores/providers.ts"

const props = defineProps<{ api: NonNullable<DeskfleetDesktopApi["superAgent"]>; workspaceId: SuperWorkspaceId }>()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
const client = usePlatformClient()
const saSummaryStore = useWorkspaceAgentSummary()
const touchWorkspace = !!(client.mobile && client.remoteWorkspaceAgent)
const { t, locale } = useI18n()
const { displayName: assistantDisplayName } = useWorkspaceAgentDisplayName(() => t("superAgent.role.assistant"))
const workspaceName = (id: string) => fleet.findWorkspace(id)?.workspace.name ?? t("superAgent.workspace")
const conversationName = (id: SuperWorkspaceId) => id === null ? t("superAgent.defaultWorkspace") : workspaceName(id)
const name = computed(() => conversationName(props.workspaceId))
const goToProject = (id: string) => { void router.push(workspaceAgentRoute(fleet.targetId, id, account?.teamId.value)) }
const project = computed(() => props.workspaceId ? fleet.findWorkspace(props.workspaceId) : undefined)
const location = computed(() => {
  if (project.value) return project.value
  const machine = fleet.findMachine(fleet.targetId)
  return machine ? { machine } : null
})
const machineTarget = useFileTarget(() => location.value?.machine.id)
const resourceTarget = useTranscriptFileTarget(() => machineTarget.value, () => props.workspaceId)
const deviceOnline = useOnline()
const docVisibility = useDocumentVisibility()
const machinePresence = computed(() => account?.machines.value.find(item => item.id === fleet.targetId))
const offlineMachine = computed(() => {
  if (deviceOnline.value === false) {
    return machinePresence.value ?? location.value?.machine ?? { id: fleet.targetId, name: fleet.localDesktopTarget.name, online: false }
  }
  if (account) {
    const machine = machinePresence.value
    if (machine?.online === false || account.connected?.value === false) {
      return machine ?? location.value?.machine ?? { id: fleet.targetId, name: fleet.localDesktopTarget.name, online: false }
    }
    return undefined
  }
  if (fleet.localDesktopTarget.online === false && (fleet.localDesktopTarget.error !== undefined || fleet.catalogError !== null)) {
    return location.value?.machine ?? { id: fleet.targetId, name: fleet.localDesktopTarget.name, online: false }
  }
  return undefined
})
const { snapshot, draft, attachments, mentions, missingAttachments, discardMissing, error, sending, saving, refresh, canRefresh, commandMenu, canSendPlain, send, retry, correct, linkMessage, createTicket, saveSettings, stop, localStops, archiveTicket, feedbackMap, loadProcess, hasExistingDraft, reEdit, hasStashedDraft, isReEditModified, beginReEdit, hydrateReEditImagePreview, cancelReEdit, manuallyFoldedIds, foldStoppedTurn, unfoldStoppedTurn } = useWorkspaceConversation(
  props.api,
  props.workspaceId,
  goToProject,
  () => !!offlineMachine.value,
  value => { saSummaryStore.observeSnapshot(fleet.targetId, value) },
)
useConnectionResume(() => { if (!offlineMachine.value) void refresh() })
const workers = computed(() => snapshot.value?.workerProviders ?? providers.providers)
const providerName = (id: string) => workers.value.find(provider => provider.id === id)?.name ?? id
const messages = computed(() => snapshot.value?.messages ?? [])
const resolvedTicketList = computed<SuperTicket[]>(() => {
  const raw = snapshot.value?.tickets ?? []
  if (!raw.length || raw.every(ticket => isValidAccentSlot(ticket.accentSlot))) return raw
  const resolvedSlots = resolveRoomTicketAccentSlots(raw)
  return raw.map(ticket => {
    if (isValidAccentSlot(ticket.accentSlot)) return ticket
    const slot = resolvedSlots.get(ticket.id)
    return slot === undefined ? ticket : { ...ticket, accentSlot: slot }
  })
})
const tickets = computed(() => new Map(resolvedTicketList.value.map(ticket => [ticket.id, ticket])))
const activeTickets = computed(() => resolvedTicketList.value.filter(ticket => !ticket.archiveState))
const archivedTickets = computed(() => resolvedTicketList.value.filter(ticket => ticket.archiveState))
const ticketMenuOpen = ref(false)
const followUpBusy = ref(false)
const followUpError = ref("")
const fetchedFollowUpRuns = ref<FollowUpRunRecord[]>([])
const extraFollowUpRuns = ref<FollowUpRunRecord[]>([])
const followUpRunsCursor = ref<{ createdAt: string; id: string }>()
const followUpRunsLoading = ref(false)
const followUpRunsLoadedOnce = ref(false)
const machineName = computed(() => account?.machine.value?.name ?? location.value?.machine.name ?? fleet.localDesktopTarget.name)
const pendingAuthScheduleCount = computed(() => snapshot.value?.followUp?.pendingAuthScheduleCount ?? 0)
const takeoverActive = computed(() =>
  !!snapshot.value?.followUp?.authorized && snapshot.value?.followUp?.takeoverAllSessions === true,
)
const needsFollowUpConsent = computed(() =>
  !!snapshot.value?.supportsProactiveFollowUp
  && !!props.api.followUpAuth
  && !takeoverActive.value
  && (!!snapshot.value.followUp?.needsConsent || pendingAuthScheduleCount.value > 0),
)

const followUpRuns = computed<FollowUpRunRecord[]>(() => {
  const primary = snapshot.value?.followUpRuns ?? fetchedFollowUpRuns.value
  const merged = new Map<string, FollowUpRunRecord>()
  for (const run of primary) merged.set(run.id, run)
  for (const run of extraFollowUpRuns.value) {
    if (!merged.has(run.id)) merged.set(run.id, run)
  }
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
})

let followUpRunsToken = 0
let followUpConsentToken = 0
let viewDisposed = false

async function loadFollowUpRuns(append = false) {
  const listRuns = props.api.followUpRuns
  if (!snapshot.value?.supportsProactiveFollowUp || !listRuns || followUpRunsLoading.value) return
  const scope = attachmentScope.value
  const api = props.api
  const workspaceId = props.workspaceId
  const token = ++followUpRunsToken
  const isCurrent = () => !viewDisposed && attachmentScope.value === scope && props.api === api && props.workspaceId === workspaceId && followUpRunsToken === token
  followUpRunsLoading.value = true
  followUpError.value = ""
  try {
    if (!append) {
      const page = await listRuns({ workspaceId: workspaceId ?? undefined, limit: 20 })
      if (!isCurrent()) return
      fetchedFollowUpRuns.value = page.runs
      extraFollowUpRuns.value = []
      followUpRunsCursor.value = page.nextCursor
      followUpRunsLoadedOnce.value = true
    } else if (followUpRunsCursor.value) {
      const page = await listRuns({ workspaceId: workspaceId ?? undefined, cursor: followUpRunsCursor.value, limit: 20 })
      if (!isCurrent()) return
      extraFollowUpRuns.value = [...extraFollowUpRuns.value, ...page.runs]
      followUpRunsCursor.value = page.nextCursor
    }
  } catch (reason) {
    if (!isCurrent()) return
    followUpError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (isCurrent()) followUpRunsLoading.value = false
  }
}

watch(() => snapshot.value, snap => {
  if (!snap) return
  if (snap.followUpRuns !== undefined) {
    if (!extraFollowUpRuns.value.length) followUpRunsCursor.value = snap.followUpRunsCursor
    return
  }
  if (snap.supportsProactiveFollowUp && props.api.followUpRuns && !followUpRunsLoadedOnce.value) {
    void loadFollowUpRuns(false)
  }
}, { immediate: true })

watch(ticketMenuOpen, open => {
  if (open && snapshot.value?.supportsProactiveFollowUp && snapshot.value?.followUpRuns === undefined && props.api.followUpRuns) {
    void loadFollowUpRuns(false)
  }
})

async function consentBackgroundFollowUp() {
  if (followUpBusy.value || !props.api.followUpAuth) return
  const scope = attachmentScope.value
  const api = props.api
  const token = ++followUpConsentToken
  const isCurrent = () => !viewDisposed && attachmentScope.value === scope && props.api === api && followUpConsentToken === token
  followUpBusy.value = true
  followUpError.value = ""
  try {
    const receipt = await enableTakeoverOnMachine(api, {
      serverUrl: account?.account.value.serverUrl,
      userId: account?.account.value.user?.id,
      teamId: account?.teamId.value,
      machineId: fleet.targetId,
    }, { platform: client.platform, deviceLabel: client.platform, machineName: machineName.value })
    if (!isCurrent()) return
    if (receipt.status === "stale_ignored" || !receipt.authorized || receipt.summary?.takeoverAllSessions !== true) {
      followUpError.value = t("superAgent.followUp.takeoverAllAuthFailed")
    }
    await refresh()
  } catch (reason) {
    if (!isCurrent()) return
    followUpError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (isCurrent()) followUpBusy.value = false
  }
}

function scheduleRoute(scheduleId: string) {
  return { name: "schedules", params: { scheduleId } }
}

function runStatusLabel(status?: FollowUpRunRecord["status"]): string {
  if (!status) return ""
  return t(`superAgent.followUp.runStatus.${status}`)
}

function evidenceAvailabilityLabel(availability: FollowUpRunRecord["evidenceAvailability"]): string {
  return t(
    availability === "archived"
      ? "superAgent.followUp.evidenceArchived"
      : availability === "deleted"
        ? "superAgent.followUp.evidenceDeleted"
        : availability === "partial"
          ? "superAgent.followUp.evidencePartial"
          : "superAgent.followUp.evidenceRestricted",
  )
}

function formatRunTime(iso?: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(locale.value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
  } catch {
    return iso.slice(0, 16).replace("T", " ")
  }
}

const confirmingArchive = ref<{ ticket: SuperTicket; archive: boolean; operationId: string }>()
function canChangeTicketArchive(ticket: SuperTicket) {
  return !!snapshot.value?.supportsTicketArchive && !!props.api.archiveTicket && (!ticket.sessionId || !!ticket.workerContext)
}
function chooseArchive(ticket: SuperTicket) {
  confirmingArchive.value = { ticket, archive: ticket.archiveState !== "archived", operationId: crypto.randomUUID() }
  ticketMenuOpen.value = false
}
const archiveDescription = computed(() => {
  const choice = confirmingArchive.value
  if (!choice) return ""
  if (!choice.ticket.sessionId) return t(choice.archive ? "superAgent.archiveUnbound" : "superAgent.restoreUnbound")
  if (choice.ticket.workerContext === "worktree") return t(choice.archive ? "agent.archiveWorktreeQuestion" : "agent.restoreWorktreeQuestion")
  return t(choice.archive ? "agent.archiveQuestion" : "agent.restoreQuestion")
})
async function confirmArchive() {
  const choice = confirmingArchive.value
  if (choice) await archiveTicket(choice.ticket.id, choice.ticket.sessionId ?? null, choice.archive, choice.operationId)
}
const requestKey = (request: SuperWorkerRequest) => JSON.stringify([request.item.sessionId, request.kind, request.item.id])
watch(() => snapshot.value?.pendingRequests, (current, previous) => {
  if (!current || !previous?.length) return
  const pending = new Set(current.filter(request => request.item.state === "pending").map(requestKey))
  for (const { kind, item } of previous.filter(request => !pending.has(requestKey(request)))) agents.clearWorkerRequest(item.sessionId, kind, item.id)
})
const lastUserMessage = computed(() => messages.value.findLast(message => message.role === "user")?.id)
const byId = computed(() => new Map(messages.value.map(message => [message.id, message])))
const feedbackById = computed(() => {
  const map = new Map<string, SuperFeedbackItem>()
  for (const entry of feedbackMap.value.values()) {
    if (entry.ack) map.set(entry.ack.itemId, entry.ack)
    for (const milestone of entry.milestones) map.set(milestone.itemId, milestone)
  }
  return map
})
function accentSlotForQuotedTarget(id: string): number | undefined {
  const quotedRow = rowById.value.get(id)
  if (quotedRow) return singleAccentSlotFor(quotedRow.linkedTickets)
  const existing = byId.value.get(id)
  if (existing) {
    if (existing.ticketIds) {
      const known = existing.ticketIds
        .map(tid => tickets.value.get(tid))
        .filter((ticket): ticket is SuperTicket => !!ticket)
      return singleAccentSlotFor(known)
    }
    return existing.ticketId ? accentSlotOfTicket(tickets.value.get(existing.ticketId)) : undefined
  }
  const item = feedbackById.value.get(id)
  if (item) {
    if (item.ticketId) return accentSlotOfTicket(tickets.value.get(item.ticketId))
    if ((item.kind === "ack" || item.kind === "milestone") && item.sourceMessageId) {
      const sourceRow = rowById.value.get(item.sourceMessageId)
      return singleAccentSlotFor(attributedTicketsForFeedbackItem(item, sourceRow?.linkedTickets ?? []))
    }
  }
  return undefined
}
const quoted = computed(() => {
  if (!draft.replyTo) return undefined
  const existing = byId.value.get(draft.replyTo)
  if (existing) return existing
  const item = feedbackById.value.get(draft.replyTo)
  if (!item) return undefined
  return { id: item.itemId, role: "assistant" as const, text: item.text, createdAt: item.createdAt, ticketId: item.ticketId, sourceMessageId: item.sourceMessageId }
})
const quotedAccentSlot = computed(() => draft.replyTo ? accentSlotForQuotedTarget(draft.replyTo) : undefined)
function replyQuote(id: string): { text: string; locatable: boolean; accentSlot?: number } | undefined {
  const existing = byId.value.get(id)
  if (existing) {
    const text = quoteText(existing)
    return text ? { text, locatable: locateTargets.value.has(id), accentSlot: accentSlotForQuotedTarget(id) } : undefined
  }
  const item = feedbackById.value.get(id)
  if (item) return item.text ? { text: item.text, locatable: locateTargets.value.has(id), accentSlot: accentSlotForQuotedTarget(id) } : undefined
  return { text: t("superAgent.quotedMessageUnavailable"), locatable: false }
}
const editor = useTemplateRef<InstanceType<typeof SessionComposer>>("editor")
const githubOpen = ref(false)
function insertGithub(item: GithubRepositoryItem) {
  attachments.value = withGithubReference(attachments.value, item)
  githubOpen.value = false
}
const unsupportedAttachments = computed(() => !!attachments.value.length && !!snapshot.value && !snapshot.value.supportsAttachments)
const attachmentScope = computed(() => JSON.stringify([account?.account?.value.serverUrl ?? "", account?.account?.value.user?.id ?? "", account?.teamId.value ?? "", fleet.targetId, props.workspaceId]))
const attachmentPreviews = computed(() => !!snapshot.value?.supportsAttachmentPreviews && !offlineMachine.value)
const readAttachment = computed(() => {
  if (!attachmentPreviews.value) return undefined
  const scope = attachmentScope.value
  const { workspaceId, api } = props
  return async (messageId: string, index: number) => {
    const result = await api.snapshot({ workspaceId, attachment: { messageId, index } })
    const preview = result.attachmentPreview
    if (attachmentScope.value === scope && props.api === api && result.workspaceId === workspaceId && preview?.messageId === messageId && preview.index === index) return preview.content
    throw new Error("Attachment unavailable")
  }
})
function quoteText(message: SuperMessage) {
  return message.text || message.attachments?.map(item => item.name).join(", ")
}
const scrollArea = useTemplateRef<InstanceType<typeof UiScrollArea>>("scrollArea")
const transcript = useTemplateRef<HTMLElement>("transcript")
const viewport = computed(() => scrollArea.value?.viewportElement)
const reading = useConversationReadingStore().session(JSON.stringify(["workspace", account?.account?.value.user?.id, account?.teamId.value, fleet.targetId, props.workspaceId]))
const stickToBottom = ref(reading.scroll?.bottom ?? true)
const activeEntry = ref<string>()
let spring: SpringScroll | undefined
const showSettings = ref(false)
watch(() => providers.providers, () => { void refresh() })
watch(showSettings, visible => { if (visible) void refresh() })
const correcting = ref<string>()
const target = ref("")
const selectedLinkTickets = ref<string[]>([])
const creatingTicketFor = ref<string>()
const newTicketTitle = ref("")
const details = ref<string>()
const busy = computed(() => sending.value || saving.value || !!offlineMachine.value)
const supportsLinkMutation = computed(() => snapshot.value?.supportsTicketLinks === true && !!props.api.linkMessage)
const supportsCreateTicket = computed(() => snapshot.value?.supportsTicketLinks === true && !!props.api.createTicket)
const rows = computed(() => workspaceMessageRows(messages.value, tickets.value, localStops.value, feedbackMap.value, snapshot.value?.messageTicketLinks))
const rowById = computed(() => new Map(rows.value.map(row => [row.message.id, row])))
interface SavedFocusScroll {
  top: number
  bottom: boolean
  activeEntry?: string
  anchorId?: string
  anchorOffset?: number
}
const focusedTicketId = ref<string>()
const savedScrollBeforeFocus = ref<SavedFocusScroll>()
const restoringFocusScroll = ref(false)
const focusedTicket = computed(() => focusedTicketId.value ? tickets.value.get(focusedTicketId.value) : undefined)
const displayedRows = computed(() => filterWorkspaceRowsByTicket(rows.value, focusedTicket.value?.id))
watch([() => !!snapshot.value, focusedTicketId, tickets], ([ready, currentId, ticketMap]) => {
  if (ready && currentId && !ticketMap.has(currentId)) {
    void exitTicketFocus(true)
  }
})
const activeProgressSources = computed(() => new Set(rows.value.flatMap(row => row.progress ? [row.progress.sourceId] : [])))
const lastMessageByTicket = computed(() => {
  const latest = new Map<string, string>()
  for (const { message, ticketIds } of rows.value) {
    for (const ticketId of ticketIds) latest.set(ticketId, message.id)
  }
  return latest
})
const supportsStop = computed(() => !!props.api.stop && snapshot.value?.supportsStop === true)
const stopChoices = computed(() => supportsStop.value ? rows.value.flatMap(({ progress }) =>
  progress && stoppableSteps(progress).length ? [progress] : []) : [])
const choosingStop = ref(false)
watch(() => stopChoices.value.length, count => { if (!count) choosingStop.value = false })
const stopUnreachable = computed(() => !!offlineMachine.value || machinePresence.value?.online === false)
const stopDisabled = computed(() => busy.value || stopUnreachable.value)
function stopLabel(choice: ReplyProgress) {
  const steps = stoppableSteps(choice)
  if (steps.length === 1) return t(steps[0]?.sharedTurn ? "superAgent.stop.turn" : "superAgent.stop.request")
  return t(steps.some(step => step.sharedTurn) ? "superAgent.stop.groupShared" : "superAgent.stop.group", { count: steps.length })
}
const cancelLabel = computed(() => stopChoices.value.length === 1 ? stopLabel(stopChoices.value[0]!) : t("superAgent.stop.choose"))
function composerStop() {
  if (stopDisabled.value) return
  if (stopChoices.value.length === 1) void stop(stopChoices.value[0]!)
  else choosingStop.value = stopChoices.value.length > 1
}
const stoppedTurns = computed(() => resolveWorkspaceStoppedTurns(messages.value, rows.value, tickets.value, localStops.value))
const transcriptEntries = computed(() => buildWorkspaceTranscript(displayedRows.value, stoppedTurns.value, manuallyFoldedIds.value))
const locateTargets = computed(() => indexWorkspaceTranscriptLocateTargets(transcriptEntries.value))
const expandedApprovals = ref(new Set<string>())
const expandedSupersededTurns = ref(new Set<string>())
const confirmingReEdit = ref<SuperMessage>()
const confirmingAbandonReEdit = ref(false)
let reEditPreviewToken = 0
let focusComposerAfterReEditDialog = false
const stoppedProgressAnchor = computed(() => {
  const map = new Map<string, string>()
  for (const meta of stoppedTurns.value.values()) {
    if (!meta.supersededById && meta.actionAnchor.kind === "progress") {
      map.set(meta.actionAnchor.messageId, meta.sourceMessageId)
    }
  }
  return map
})
function stoppedActionSourceForProgress(anchorMessageId: string): string | undefined {
  return stoppedProgressAnchor.value.get(anchorMessageId)
}
function stoppedActionSourceForWorkerResult(message: SuperMessage): string | undefined {
  if (!message.sourceMessageId) return undefined
  const meta = stoppedTurns.value.get(message.sourceMessageId)
  if (!meta || meta.supersededById) return undefined
  return meta.actionAnchor.kind === "workerResult" && meta.actionAnchor.messageId === message.id ? meta.sourceMessageId : undefined
}
function entryGroups(entry: TranscriptEntry) {
  if (entry.kind === "group") return [entry.group]
  return entry.reason === "superseded" && expandedSupersededTurns.value.has(entry.id) ? entry.groups : []
}
function toggleFoldedStoppedTurn(entry: Extract<TranscriptEntry, { kind: "foldedStoppedTurn" }>) {
  if (entry.reason === "manual") {
    unfoldStoppedTurn(entry.id)
    return
  }
  if (expandedSupersededTurns.value.has(entry.id)) expandedSupersededTurns.value.delete(entry.id)
  else expandedSupersededTurns.value.add(entry.id)
}
function enterReEdit(source: SuperMessage, stashCurrent: boolean) {
  beginReEdit(source, { stashCurrent })
  const read = readAttachment.value
  if (read && source.attachments?.length) {
    const token = ++reEditPreviewToken
    const scope = attachmentScope.value
    for (const [index, item] of source.attachments.entries()) {
      if (item.type !== "image") continue
      void read(source.id, index)
        .then(preview => {
          if (viewDisposed || token !== reEditPreviewToken || attachmentScope.value !== scope) return
          if (preview.type === "image") {
            hydrateReEditImagePreview(source.id, index, `data:${preview.mimeType};base64,${preview.data}`)
          }
        })
        .catch(() => {})
    }
  }
  void nextTick(() => editor.value?.focus(true))
}
function requestReEdit(sourceMessageId: string) {
  if (sending.value) return
  const meta = stoppedTurns.value.get(sourceMessageId)
  const source = byId.value.get(sourceMessageId)
  if (!meta || !source || source.role !== "user") return
  if (reEdit.value?.sourceMessageId === source.id) {
    void nextTick(() => editor.value?.focus(true))
    return
  }
  if (hasExistingDraft.value) {
    confirmingReEdit.value = source
    return
  }
  enterReEdit(source, false)
}
async function confirmStashAndReEdit() {
  const source = confirmingReEdit.value
  if (!source) return
  focusComposerAfterReEditDialog = true
  enterReEdit(source, true)
}
function onConfirmReEditClose() {
  confirmingReEdit.value = undefined
  if (focusComposerAfterReEditDialog) {
    focusComposerAfterReEditDialog = false
    void nextTick(() => editor.value?.focus(true))
  }
}
function handleCancelReEdit() {
  if (!reEdit.value || sending.value) return
  if (isReEditModified.value && hasStashedDraft.value) {
    confirmingAbandonReEdit.value = true
    return
  }
  cancelReEdit("auto")
  void nextTick(() => editor.value?.focus())
}
function resolveAbandonReEdit(mode: "restore-stashed" | "keep-as-draft") {
  confirmingAbandonReEdit.value = false
  cancelReEdit(mode)
  void nextTick(() => editor.value?.focus())
}
const locatedMessage = ref<string>()
let locateToken = 0
const { start: clearHighlightLater, stop: cancelHighlightClear } = useTimeoutFn(() => { locatedMessage.value = undefined }, 2000, { immediate: false })
const seenViewportMessageIds = new Set<string>()
let readObserver: IntersectionObserver | undefined
const saVisibleMarkers = computed(() => snapshot.value ? extractSaVisibleMarkers(snapshot.value.messages, snapshot.value.tickets) : [])
const pageActiveAndVisible = computed(() => {
  if (viewDisposed || docVisibility.value === "hidden") return false
  if (account?.machineId.value && account.machineId.value !== fleet.targetId) return false
  if (route.name === "session") return false
  if (props.workspaceId !== null && route.name === "workspace-agent" && typeof route.params.workspaceId === "string" && route.params.workspaceId !== props.workspaceId) return false
  return true
})

function advanceReadFromSeen(): void {
  if (focusedTicket.value || !pageActiveAndVisible.value || !snapshot.value || !saVisibleMarkers.value.length) return
  let highest: (typeof saVisibleMarkers.value)[number] | undefined
  const seenErrorKeys: string[] = []
  for (const marker of saVisibleMarkers.value) {
    if (!seenViewportMessageIds.has(marker.messageId)) continue
    if (!highest || marker.order >= highest.order) highest = marker
    if (marker.kind === "error") seenErrorKeys.push(marker.key)
  }
  if (!highest) return
  void saSummaryStore.markVisibleSeen(fleet.targetId, props.workspaceId, {
    key: highest.key,
    order: highest.order,
    messageId: highest.messageId,
    ...(highest.createdAt ? { createdAt: highest.createdAt } : {}),
  }, seenErrorKeys, props.api)
}

function scanViewportRead(): void {
  if (focusedTicket.value || !pageActiveAndVisible.value || !snapshot.value || !saVisibleMarkers.value.length) return
  const vp = viewport.value
  const root = transcript.value
  if (!vp || !root) return
  const vpRect = vp.getBoundingClientRect()
  const hasRealViewport = vpRect.height > 0 || vp.clientHeight > 0
  let added = false
  for (const marker of saVisibleMarkers.value) {
    const el = root.querySelector<HTMLElement>(`[data-super-message="${CSS.escape(marker.messageId)}"]`)
    if (!el) continue
    if (hasRealViewport) {
      const rect = el.getBoundingClientRect()
      const vpTop = vpRect.height > 0 ? vpRect.top : 0
      const vpBottom = vpRect.height > 0 ? vpRect.bottom : vp.clientHeight
      const intersects = rect.height > 0
        ? (rect.bottom > vpTop && rect.top < vpBottom)
        : (rect.top >= vpTop && rect.top <= vpBottom)
      if (intersects && !seenViewportMessageIds.has(marker.messageId)) {
        seenViewportMessageIds.add(marker.messageId)
        added = true
      }
    } else if (stickToBottom.value) {
      // Zero-layout DOM (e.g. unmocked jsdom): advance only while anchored at the bottom of the visible page.
      if (!seenViewportMessageIds.has(marker.messageId)) {
        seenViewportMessageIds.add(marker.messageId)
        added = true
      }
    }
  }
  if (added || seenViewportMessageIds.size) advanceReadFromSeen()
}

function rebindReadObserver(): void {
  readObserver?.disconnect()
  readObserver = undefined
  if (!pageActiveAndVisible.value || typeof IntersectionObserver === "undefined") return
  const vp = viewport.value
  const root = transcript.value
  if (!vp || !root || !saVisibleMarkers.value.length) return
  readObserver = new IntersectionObserver(entries => {
    if (!pageActiveAndVisible.value) return
    let changed = false
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const id = (entry.target as HTMLElement).dataset.superMessage
      if (id && !seenViewportMessageIds.has(id)) {
        seenViewportMessageIds.add(id)
        changed = true
      }
    }
    if (changed) advanceReadFromSeen()
  }, { root: vp, threshold: 0.01 })
  for (const marker of saVisibleMarkers.value) {
    const el = root.querySelector<HTMLElement>(`[data-super-message="${CSS.escape(marker.messageId)}"]`)
    if (el) readObserver.observe(el)
  }
}

watch(attachmentScope, () => {
  expandedApprovals.value.clear()
  expandedSupersededTurns.value.clear()
  confirmingReEdit.value = undefined
  confirmingAbandonReEdit.value = false
  reEditPreviewToken++
  focusedTicketId.value = undefined
  savedScrollBeforeFocus.value = undefined
  creatingTicketFor.value = undefined
  newTicketTitle.value = ""
  selectedLinkTickets.value = []
  locateToken++
  cancelHighlightClear()
  locatedMessage.value = undefined
  followUpRunsToken++
  followUpConsentToken++
  followUpRunsLoading.value = false
  followUpBusy.value = false
  fetchedFollowUpRuns.value = []
  extraFollowUpRuns.value = []
  followUpRunsCursor.value = undefined
  followUpRunsLoadedOnce.value = false
  followUpError.value = ""
  seenViewportMessageIds.clear()
  readObserver?.disconnect()
  readObserver = undefined
}, { flush: "sync" })

function linkedTicketIdForRun(run: FollowUpRunRecord): string | undefined {
  if (run.ticketId && tickets.value.has(run.ticketId)) return run.ticketId
  if (run.deliveredMessageId) {
    const row = rowById.value.get(run.deliveredMessageId)
    if (row?.ticketIds.length === 1 && tickets.value.has(row.ticketIds[0]!)) return row.ticketIds[0]!
    const msgTicketId = byId.value.get(run.deliveredMessageId)?.ticketId
    if (msgTicketId && tickets.value.has(msgTicketId)) return msgTicketId
  }
  return undefined
}
const runsByTicketId = computed(() => {
  const map = new Map<string, FollowUpRunRecord[]>()
  for (const run of followUpRuns.value) {
    const tid = linkedTicketIdForRun(run)
    if (!tid) continue
    const list = map.get(tid) ?? []
    list.push(run)
    map.set(tid, list)
  }
  return map
})
const standaloneFollowUpRuns = computed(() =>
  followUpRuns.value.filter(run => !linkedTicketIdForRun(run)),
)
const ticketBadgeCount = computed(() => activeTickets.value.length + standaloneFollowUpRuns.value.length)

interface FollowUpMessageRunInfo {
  title: string
  sourceKind: "schedule" | "session"
  sourceTitle?: string
  scheduleId?: string
  runId?: string
  status?: FollowUpRunRecord["status"]
  provider?: string
  detail?: string
  error?: string
  timestamp?: string
  sessionId?: string
  evidenceAvailability: FollowUpRunRecord["evidenceAvailability"]
}

function matchFollowUpRun(message: SuperMessage): FollowUpRunRecord | undefined {
  const prov = message.provenance
  if (!prov || prov.origin !== "sa_follow_up") return undefined
  return followUpRuns.value.find(run => run.deliveredMessageId === message.id)
    ?? (prov.runId ? followUpRuns.value.find(run => run.runId === prov.runId && run.sourceId === prov.sourceId) : undefined)
    ?? (prov.runKey ? followUpRuns.value.find(run => run.runKey === prov.runKey && run.sourceId === prov.sourceId) : undefined)
    ?? (message.sessionId && message.turnId ? followUpRuns.value.find(run => run.sessionId === message.sessionId && run.turnId === message.turnId) : undefined)
}

const runInfoByMessageId = computed(() => {
  const map = new Map<string, FollowUpMessageRunInfo>()
  for (const message of messages.value) {
    const prov = message.provenance
    if (!prov || prov.origin !== "sa_follow_up" || message.role !== "assistant") continue
    const matched = matchFollowUpRun(message)
    const sourceTitle = prov.scheduleTitle ?? matched?.scheduleTitle
    const title = sourceTitle ?? prov.sourceId
    map.set(message.id, {
      title,
      sourceKind: prov.sourceKind,
      sourceTitle,
      scheduleId: prov.scheduleId ?? matched?.scheduleId,
      runId: prov.runId ?? matched?.runId,
      status: prov.runStatus ?? matched?.status,
      provider: prov.provider ?? matched?.provider,
      detail: prov.detail ?? matched?.detail,
      error: matched?.error,
      timestamp: prov.finishedAt ?? matched?.finishedAt ?? prov.startedAt ?? matched?.startedAt ?? message.createdAt,
      sessionId: message.sessionId ?? prov.sessionId ?? matched?.sessionId,
      evidenceAvailability: matched?.evidenceAvailability ?? prov.evidenceAvailability ?? "available",
    })
  }
  return map
})

function visibleSessionsFor(sessions: { id: string; title?: string }[], runInfo?: FollowUpMessageRunInfo) {
  if (!runInfo) return sessions
  const filtered = runInfo.evidenceAvailability === "deleted" && runInfo.sessionId
    ? sessions.filter(item => item.id !== runInfo.sessionId)
    : [...sessions]
  if (runInfo.sessionId && runInfo.evidenceAvailability !== "deleted" && !filtered.some(item => item.id === runInfo.sessionId)) {
    filtered.push({ id: runInfo.sessionId, title: undefined })
  }
  return filtered
}
function toggleApprovals(id: string) {
  if (expandedApprovals.value.has(id)) expandedApprovals.value.delete(id)
  else expandedApprovals.value.add(id)
}
const progressText = (summary: string) => workerSummary(summary, t("superAgent.actions.workerNotStarted"))
function correctionSource(message?: SuperMessage) {
  if (!message) return
  const source = message.role === "user" ? message : byId.value.get(message.sourceMessageId ?? "")
  if (source?.role === "user" && source.state !== "transferred" && source.state !== "stopped") return source
}
const original = computed(() => correcting.value ? correctionSource(byId.value.get(correcting.value)) : undefined)
const correctionChoices = computed(() => {
  const current = original.value?.ticketId
  return activeTickets.value.filter(ticket => ticket.id !== current)
})
const outline = computed(() => {
  const items = new Map<string, { id: string; label: string; reply?: string }>()
  for (const entry of transcriptEntries.value) {
    for (const group of entryGroups(entry)) {
      for (const { message } of group.rows) {
        if (message.role === "user") items.set(message.id, { id: message.id, label: quoteText(message) ?? "" })
        else if (message.sourceMessageId && message.text && message.workerEvent !== "permission") {
          const item = items.get(message.sourceMessageId)
          if (item) item.reply = message.text
        }
      }
    }
  }
  return [...items.values()]
})
function sourceForOutline(message?: SuperMessage) {
  if (message?.role === "user") return message.id
  if (message?.sourceMessageId && byId.value.get(message.sourceMessageId)?.role === "user") return message.sourceMessageId
}
const lastOutlineEntry = computed(() => sourceForOutline(displayedRows.value.findLast(row => sourceForOutline(row.message))?.message))
function entries() {
  return Array.from(transcript.value?.querySelectorAll<HTMLElement>("[data-outline-source]") ?? [])
}
function captureCurrentScrollPosition(): SavedFocusScroll {
  const el = viewport.value
  const top = el?.scrollTop ?? reading.scroll?.top ?? 0
  const bottom = stickToBottom.value
  let anchorId: string | undefined
  let anchorOffset: number | undefined
  if (el && !bottom) {
    const vpRect = el.getBoundingClientRect()
    if (vpRect.height > 0) {
      const nodes = Array.from(transcript.value?.querySelectorAll<HTMLElement>("[data-super-message]") ?? [])
      const firstVisible = nodes.find(node => {
        const rect = node.getBoundingClientRect()
        return rect.height > 0 && rect.bottom > vpRect.top
      })
      if (firstVisible?.dataset.superMessage) {
        anchorId = firstVisible.dataset.superMessage
        anchorOffset = firstVisible.getBoundingClientRect().top - vpRect.top
      }
    }
  }
  return { top, bottom, activeEntry: activeEntry.value, anchorId, anchorOffset }
}
async function enterTicketFocus(ticketId: string) {
  if (!tickets.value.has(ticketId)) return
  if (!focusedTicketId.value) {
    savedScrollBeforeFocus.value = captureCurrentScrollPosition()
  }
  spring?.cancel()
  spring = undefined
  focusedTicketId.value = ticketId
  ticketMenuOpen.value = false
  await nextTick()
  if (viewport.value) viewport.value.scrollTop = 0
}
async function exitTicketFocus(restoreScroll = true) {
  const saved = savedScrollBeforeFocus.value
  focusedTicketId.value = undefined
  savedScrollBeforeFocus.value = undefined
  if (!restoreScroll || !saved) return
  restoringFocusScroll.value = true
  try {
    spring?.cancel()
    spring = undefined
    stickToBottom.value = saved.bottom
    activeEntry.value = saved.activeEntry
    reading.scroll = { top: saved.top, bottom: saved.bottom }
    await nextTick()
    const el = viewport.value
    if (!el) return
    if (saved.bottom) {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTop = saved.top
      if (saved.anchorId && saved.anchorOffset !== undefined) {
        const vpRect = el.getBoundingClientRect()
        const anchor = transcript.value?.querySelector<HTMLElement>(`[data-super-message="${CSS.escape(saved.anchorId)}"]`)
        const anchorRect = anchor?.getBoundingClientRect()
        if (vpRect.height > 0 && anchorRect && anchorRect.height > 0) {
          const delta = (anchorRect.top - vpRect.top) - saved.anchorOffset
          if (Math.abs(delta) > 1) el.scrollTop = Math.max(0, el.scrollTop + delta)
        }
      }
    }
    reading.scroll = { top: el.scrollTop, bottom: saved.bottom }
  } finally {
    restoringFocusScroll.value = false
    scanViewportRead()
  }
}
function toggleTicketFocus(ticketId: string) {
  if (focusedTicketId.value === ticketId) void exitTicketFocus(true)
  else void enterTicketFocus(ticketId)
}
function followScroll() {
  const el = viewport.value
  if (!el || spring || !snapshot.value || restoringFocusScroll.value) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 100
  if (focusedTicket.value) {
    if (atBottom) activeEntry.value = lastOutlineEntry.value
    else {
      const items = entries()
      const top = el.getBoundingClientRect().top + 80
      activeEntry.value = (items.findLast(item => item.getBoundingClientRect().top <= top) ?? items[0])?.dataset.outlineSource
    }
    return
  }
  stickToBottom.value = atBottom
  reading.scroll = { top: el.scrollTop, bottom: stickToBottom.value }
  if (stickToBottom.value) activeEntry.value = lastOutlineEntry.value
  else {
    const items = entries()
    const top = el.getBoundingClientRect().top + 80
    activeEntry.value = (items.findLast(item => item.getBoundingClientRect().top <= top) ?? items[0])?.dataset.outlineSource
  }
  scanViewportRead()
}
function locateElement(entry: HTMLElement) {
  spring?.cancel()
  spring = undefined
  stickToBottom.value = false
  entry.scrollIntoView({ block: "start", behavior: "instant" })
  activeEntry.value = entry.dataset.outlineSource ?? entry.closest<HTMLElement>("[data-outline-source]")?.dataset.outlineSource
}
function findLocatedElement(target: WorkspaceLocateTarget): HTMLElement | null {
  const root = transcript.value
  if (!root) return null
  const escaped = CSS.escape(target.id)
  if (target.kind === "message") return root.querySelector<HTMLElement>(`[data-super-message="${escaped}"]`)
  const attr = target.feedbackKind === "ack" ? "data-feedback-ack" : "data-feedback-milestone"
  return root.querySelector<HTMLElement>(`[${attr}="${escaped}"]`)
}
function locateEntry(id: string) {
  const entry = transcript.value?.querySelector<HTMLElement>(`[data-super-message="${CSS.escape(id)}"]`)
  if (!entry) {
    void locateMessage(id)
    return
  }
  locateElement(entry)
}
async function locateMessage(id: string): Promise<boolean> {
  const target = locateTargets.value.get(id)
  if (!target) return false
  const token = ++locateToken
  if (target.foldedTurnId) {
    if (target.foldedTurnReason === "manual") unfoldStoppedTurn(target.foldedTurnId)
    else expandedSupersededTurns.value.add(target.foldedTurnId)
  }
  if (target.kind === "message" && target.approvalGroupId) expandedApprovals.value.add(target.approvalGroupId)
  ticketMenuOpen.value = false
  locatedMessage.value = target.id
  await nextTick()
  if (token !== locateToken) return false
  const entry = findLocatedElement(target)
  if (!entry) {
    if (locatedMessage.value === target.id) locatedMessage.value = undefined
    return false
  }
  locateElement(entry)
  clearHighlightLater()
  return true
}
async function locateTicket(ticketId: string) {
  const id = lastMessageByTicket.value.get(ticketId)
  if (!id) return
  if (focusedTicket.value && focusedTicket.value.id !== ticketId) {
    await exitTicketFocus(false)
    await nextTick()
  }
  await locateMessage(id)
}
async function locatePreviousUserMessage(messageId: string) {
  const id = previousUserMessageId(displayedRows.value, messageId)
  if (!id) return
  await locateMessage(id)
}
function scrollToBottom() {
  const el = viewport.value
  if (!el) return
  stickToBottom.value = true
  const animation = scrollSpring(el, el.scrollHeight)
  spring = animation
  void animation.finished.then(() => { if (spring === animation) { spring = undefined; followScroll() } })
}
function followNewContent() {
  if (snapshot.value && !focusedTicket.value && !restoringFocusScroll.value && stickToBottom.value && viewport.value && !spring) {
    viewport.value.scrollTop = viewport.value.scrollHeight
    activeEntry.value = lastOutlineEntry.value
  }
}
watch(() => !!snapshot.value, async ready => {
  if (!ready) return
  await nextTick()
  if (!stickToBottom.value && viewport.value && reading.scroll) viewport.value.scrollTop = reading.scroll.top
  followNewContent()
})
watch(() => displayedRows.value.at(-1)?.message.id, followNewContent, { flush: "post" })
watch(
  [() => saVisibleMarkers.value.map(m => `${m.key}:${m.order}`).join(","), pageActiveAndVisible, viewport],
  async () => {
    await nextTick()
    rebindReadObserver()
    scanViewportRead()
  },
  { flush: "post", immediate: true },
)
useResizeObserver(transcript, () => {
  followNewContent()
  scanViewportRead()
})
onBeforeUnmount(() => {
  viewDisposed = true
  followUpRunsToken++
  followUpConsentToken++
  readObserver?.disconnect()
  readObserver = undefined
  spring?.cancel(); spring = undefined
})
function quote(message: Pick<SuperMessage, "id">) {
  draft.replyTo = message.id
  editor.value?.focus()
}
async function submit() {
  if (!focusedTicket.value) stickToBottom.value = true
  await send()
}
function canEditMessageLinks(message: SuperMessage): boolean {
  if (!supportsLinkMutation.value) return false
  if (message.command || message.state === "transferred" || message.state === "stopped" || message.state === "routing") return false
  const currentIds = rowById.value.get(message.id)?.ticketIds ?? []
  return activeTickets.value.length > 0 || currentIds.length > 0
}
function canCreateTicketFor(message: SuperMessage): boolean {
  if (!supportsCreateTicket.value) return false
  return !message.command && message.state !== "transferred" && message.state !== "stopped" && message.state !== "routing"
}
function canAttributeMessage(message: SuperMessage): boolean {
  return canEditMessageLinks(message) || canCorrect(message) || canCreateTicketFor(message)
}
function linkableTicketsFor(messageId: string): SuperTicket[] {
  const current = new Set(rowById.value.get(messageId)?.ticketIds ?? [])
  const list: SuperTicket[] = [...activeTickets.value]
  for (const archived of archivedTickets.value) {
    if (current.has(archived.id)) list.push(archived)
  }
  return list
}
function openAttributionEditor(id: string) {
  creatingTicketFor.value = undefined
  correcting.value = id
  target.value = ""
  selectedLinkTickets.value = [...(rowById.value.get(id)?.ticketIds ?? [])]
}
function toggleLinkSelection(ticketId: string) {
  if (selectedLinkTickets.value.includes(ticketId)) {
    selectedLinkTickets.value = selectedLinkTickets.value.filter(id => id !== ticketId)
  } else {
    selectedLinkTickets.value = [...selectedLinkTickets.value, ticketId]
  }
}
async function applyCorrection() {
  if (original.value && target.value && await correct(original.value.id, target.value)) correcting.value = undefined
}
async function applyLinkEdit(messageId: string) {
  if (await linkMessage(messageId, [...selectedLinkTickets.value])) {
    correcting.value = undefined
    details.value = undefined
  }
}
async function clearLinkEdit(messageId: string) {
  if (await linkMessage(messageId, [])) {
    selectedLinkTickets.value = []
    correcting.value = undefined
    details.value = undefined
  }
}
function defaultTitleForMessage(message: SuperMessage): string {
  const source = message.role === "assistant" && message.sourceMessageId ? byId.value.get(message.sourceMessageId) : undefined
  const raw = (source?.text || message.text || "").trim().replace(/\s+/gu, " ")
  return raw.slice(0, 48)
}
function openCreateTicketForm(message: SuperMessage) {
  correcting.value = undefined
  creatingTicketFor.value = message.id
  newTicketTitle.value = defaultTitleForMessage(message)
}
async function applyCreateTicket(messageId: string) {
  const title = newTicketTitle.value.trim()
  if (!title) return
  if (await createTicket(messageId, title)) {
    creatingTicketFor.value = undefined
    newTicketTitle.value = ""
    details.value = undefined
  }
}
function sessionRoute(sessionId: string) {
  return workspaceSessionRoute(fleet.targetId, props.workspaceId, sessionId, account?.teamId.value)
}
function isPureUnattributedEntry(row: WorkspaceRow): boolean {
  const { message, linkedTickets, sessions } = row
  const runInfo = runInfoByMessageId.value.get(message.id)
  if (linkedTickets.length > 0 || runInfo || visibleSessionsFor(sessions, runInfo).length > 0) return false
  if (message.reason && message.state !== "failed" && message.state !== "uncertain") return false
  return true
}
function toggleDetails(id: string) {
  if (details.value === id) {
    details.value = undefined
    correcting.value = undefined
    creatingTicketFor.value = undefined
    return
  }
  details.value = id
  correcting.value = undefined
  creatingTicketFor.value = undefined
  const row = rowById.value.get(id)
  if (row && isPureUnattributedEntry(row)) {
    if (canEditMessageLinks(row.message) || canCorrect(row.message)) {
      openAttributionEditor(id)
    } else if (canCreateTicketFor(row.message)) {
      openCreateTicketForm(row.message)
    }
  }
}
function supportsFork(sessionId: string) {
  const session = agents.sessions[sessionId]
  return !session || session.archiveState === "active" && session.lifecycle === "ready" && !!session.capabilities?.fork
}
function openFork(sessionId: string, turnId: string) {
  const route = sessionRoute(sessionId)
  void router.push({ ...route, query: { ...route.query, forkTurn: turnId } })
}
function canCorrect(message: SuperMessage) {
  const source = correctionSource(message)
  return !!source && !source.command && activeTickets.value.some(ticket => ticket.id !== source.ticketId)
}
function visibleFeedbackFor(feedback?: WorkspaceRow["feedback"]) {
  return filterFeedbackForFocusedTicket(feedback, focusedTicket.value?.id)
}
function visibleProgressFor(progress?: ReplyProgress) {
  return filterProgressForFocusedTicket(progress, focusedTicket.value?.id)
}
function hasVisibleFeedbackGroup(row: WorkspaceRow): boolean {
  if (row.message.role !== "user") return false
  const scopedProgress = visibleProgressFor(row.progress)
  const scopedFeedback = visibleFeedbackFor(row.feedback)
  return Boolean(
    scopedProgress
    || scopedFeedback?.ack
    || scopedFeedback?.milestones.length
    || scopedFeedback?.finalPreviews.length
    || (scopedFeedback?.hasProcess && !activeProgressSources.value.has(row.message.id)),
  )
}
function attributedTicketsForFeedbackItem(item: SuperFeedbackItem, linkedTickets: readonly SuperTicket[]): SuperTicket[] {
  if (item.ticketId) {
    const owned = tickets.value.get(item.ticketId)
    return owned ? [owned] : []
  }
  return [...linkedTickets]
}
function singleAccentSlotFor(list: readonly SuperTicket[]): number | undefined {
  if (list.length !== 1) return undefined
  const slot = list[0]!.accentSlot
  return isValidAccentSlot(slot) ? slot : undefined
}
function accentSlotOfTicket(ticket?: SuperTicket): number | undefined {
  return ticket && isValidAccentSlot(ticket.accentSlot) ? ticket.accentSlot : undefined
}
function feedbackGroupAccentSlot(row: WorkspaceRow): number | undefined {
  const scopedProgress = visibleProgressFor(row.progress)
  const scopedFeedback = visibleFeedbackFor(row.feedback)
  const ids = new Set<string>()
  for (const step of scopedProgress?.steps ?? []) {
    if (step.ticketId) ids.add(step.ticketId)
  }
  if (scopedFeedback?.ack) {
    for (const ticket of attributedTicketsForFeedbackItem(scopedFeedback.ack, row.linkedTickets)) ids.add(ticket.id)
  }
  for (const milestone of scopedFeedback?.milestones ?? []) {
    for (const ticket of attributedTicketsForFeedbackItem(milestone, row.linkedTickets)) ids.add(ticket.id)
  }
  for (const preview of scopedFeedback?.finalPreviews ?? []) {
    for (const ticket of attributedTicketsForFeedbackItem(preview, row.linkedTickets)) ids.add(ticket.id)
  }
  if (ids.size === 0) return singleAccentSlotFor(row.linkedTickets)
  if (ids.size !== 1) return undefined
  const [ticketId] = ids
  return accentSlotOfTicket(tickets.value.get(ticketId!))
}
</script>

<template>
  <PaneHeader>
    <span class="inline-flex min-w-0 max-w-full items-center gap-2"><Folder v-if="workspaceId" :size="15" class="shrink-0" aria-hidden="true" /><MessagesSquare v-else :size="15" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ name }}</span></span>
    <template #actions>
      <PopoverRoot v-if="workspaceId && project?.workspace.githubRepositories?.length" v-model:open="githubOpen">
        <PopoverTrigger type="button" :aria-label="t('githubSettings.title')" :title="t('githubSettings.title')" :class="touchWorkspace && 'min-h-11 min-w-11'" class="app-no-drag ui-button-ghost h-7 px-2 data-[state=open]:bg-ui-hover">
          <GithubIcon :size="16" />
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent :as="SpringSurface" align="end" :side-offset="6" :collision-padding="8" :aria-label="t('githubSettings.title')" class="ui-menu z-50 h-[min(60dvh,var(--reka-popover-content-available-height))] w-96 max-w-[calc(100vw-1rem)] overflow-hidden p-0">
            <GithubPanel :workspace-id="workspaceId" :insert-disabled="!snapshot?.supportsAttachments || sending || saving" @insert="insertGithub" />
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
      <PopoverRoot v-if="tickets.size || followUpRuns.length" v-model:open="ticketMenuOpen">
        <PopoverTrigger type="button" data-tickets-menu :class="touchWorkspace && 'min-h-11'" class="app-no-drag ui-button-ghost h-7 px-2 data-[state=open]:bg-ui-hover">
          <ClipboardList :size="15" aria-hidden="true" />{{ t("superAgent.tickets", { count: ticketBadgeCount }) }}
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent :as="SpringSurface" align="end" :side-offset="6" :collision-padding="8" :aria-label="t('superAgent.ticketList')" class="ui-menu z-50 w-96 max-w-[calc(100vw-1rem)] max-h-[min(60dvh,var(--reka-popover-content-available-height))] overflow-y-auto overscroll-contain p-3">
            <template v-for="group in [{ archived: false, items: activeTickets }, { archived: true, items: archivedTickets }]" :key="String(group.archived)">
              <component :is="group.archived ? 'details' : 'div'" v-if="group.items.length">
                <summary v-if="group.archived" :class="touchWorkspace && 'min-h-11 py-2'" class="cursor-pointer py-1.5 text-sm text-ui-text-muted">{{ t("superAgent.archivedTickets", { count: group.items.length }) }}</summary>
                <div v-for="ticket in group.items" :key="ticket.id" class="flex items-start gap-1">
                  <details class="min-w-0 flex-1 break-words py-1.5">
                    <summary :class="touchWorkspace && 'min-h-11 py-2'" class="cursor-pointer text-sm font-medium"><span
                      data-sa-ticket-menu-title
                      :data-sa-ticket-id="ticket.id"
                      :data-sa-accent-slot="accentSlotOfTicket(ticket)"
                      :class="accentSlotOfTicket(ticket) !== undefined ? 'sa-ticket-accent sa-ticket-label' : undefined"
                    >{{ ticket.title }}</span> <small v-if="ticket.archiveState === 'archiving'" class="text-ui-text-muted">{{ t('superAgent.archivingTicket') }}</small><small v-else-if="!ticket.archiveState && hasTicketStatus(ticket.status)" class="text-ui-text-muted">{{ t(`superAgent.status.${ticket.status}`) }}</small></summary>
                    <p class="my-1.5 whitespace-pre-wrap text-sm">{{ ticket.scope }}</p>
                    <p v-if="ticket.latestAcceptance" class="my-1 select-text whitespace-pre-wrap text-sm">{{ t('superAgent.acceptance', { text: ticket.latestAcceptance }) }}</p>
                    <p v-if="ticket.summary && ticket.summary !== ticket.scope" class="my-1.5 whitespace-pre-wrap text-sm text-ui-text-muted">{{ progressText(ticket.summary) }}</p>
                    <p v-if="ticket.referenceTicketId && tickets.has(ticket.referenceTicketId)" class="my-1 text-xs text-ui-text-muted">{{ t('superAgent.reference', { name: tickets.get(ticket.referenceTicketId)?.title }) }}</p>
                    <div class="flex flex-wrap items-center gap-x-3 text-xs text-ui-accent" :class="touchWorkspace && 'workspace-touch-actions'">
                      <RouterLink v-if="ticket.sessionId && (!snapshot?.supportsTicketArchive || ticket.workerContext)" :to="sessionRoute(ticket.sessionId)" class="inline-flex items-center">{{ t('superAgent.openSession') }}</RouterLink>
                      <button v-if="canChangeTicketArchive(ticket)" type="button" :disabled="busy" @click="chooseArchive(ticket)">{{ t(ticket.archiveState === 'archived' ? 'superAgent.restoreTicket' : 'superAgent.archiveTicket') }}</button>
                      <span v-else-if="ticket.archiveState && ticket.sessionId && !ticket.workerContext" class="text-ui-text-muted">{{ t('superAgent.workerUnavailable') }}</span>
                    </div>
                    <div v-if="runsByTicketId.get(ticket.id)?.length" data-ticket-linked-runs class="mt-2 flex flex-col gap-1.5 border-t border-ui-border pt-2">
                      <span class="text-[11px] font-medium text-ui-text-muted">{{ t("superAgent.followUp.linkedRuns") }}</span>
                      <div v-for="run in runsByTicketId.get(ticket.id)" :key="run.id" :data-ticket-run="run.id" class="rounded-md border border-ui-border px-2 py-1.5 text-xs">
                        <div class="flex flex-wrap items-center justify-between gap-1 text-[11px] text-ui-text-muted">
                          <span>{{ runStatusLabel(run.status) }}<template v-if="run.provider"> · {{ providerName(run.provider) }}</template></span>
                          <time :datetime="run.finishedAt ?? run.startedAt">{{ formatRunTime(run.finishedAt ?? run.startedAt) }}</time>
                        </div>
                        <p class="my-1 select-text whitespace-pre-wrap text-xs text-ui-text">{{ run.summary }}</p>
                        <p v-if="run.detail && run.detail.trim() !== run.summary.trim()" data-ticket-run-detail class="my-1 select-text whitespace-pre-wrap text-[11px] text-ui-text-muted">{{ run.detail }}</p>
                        <p v-else-if="run.error && !run.summary.includes(run.error)" class="my-1 select-text whitespace-pre-wrap text-[11px] text-ui-danger">{{ run.error }}</p>
                        <p v-if="run.evidenceAvailability !== 'available'" class="my-0.5 text-[11px] text-ui-text-faint">{{ evidenceAvailabilityLabel(run.evidenceAvailability) }}</p>
                        <div class="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ui-accent" :class="touchWorkspace && 'workspace-touch-actions'">
                          <RouterLink v-if="run.sessionId && run.evidenceAvailability !== 'deleted'" :to="sessionRoute(run.sessionId)" data-ticket-run-open-session class="inline-flex items-center no-underline hover:underline">{{ t("superAgent.openSession") }}</RouterLink>
                          <RouterLink v-if="run.scheduleId" :to="scheduleRoute(run.scheduleId)" data-ticket-run-open-schedule class="inline-flex items-center no-underline hover:underline">{{ t("superAgent.followUp.openSchedule") }}</RouterLink>
                          <button v-if="run.deliveredMessageId && byId.has(run.deliveredMessageId)" type="button" data-ticket-run-locate class="text-ui-accent" @click="locateMessage(run.deliveredMessageId)">{{ t("superAgent.followUp.locateRunMessage", { name: run.scheduleTitle ?? run.sourceId }) }}</button>
                        </div>
                      </div>
                    </div>
                  </details>
                  <div class="mt-0.5 flex shrink-0 items-center">
                    <UiButton variant="ghost" size="icon"
                      data-ticket-focus
                      :data-ticket-focus-id="ticket.id"
                      :aria-pressed="focusedTicketId === ticket.id"
                      :class="[touchWorkspace && 'min-h-11 min-w-11', focusedTicketId === ticket.id && 'bg-ui-hover text-ui-accent']"
                      :label="focusedTicketId === ticket.id ? t('superAgent.exitFocusTicket', { name: ticket.title }) : t('superAgent.focusTicket', { name: ticket.title })"
                      @click="toggleTicketFocus(ticket.id)">
                      <Focus :size="16" :stroke-width="1.75" aria-hidden="true" />
                    </UiButton>
                    <UiButton variant="ghost" size="icon" :class="touchWorkspace && 'min-h-11 min-w-11'"
                      :label="t('superAgent.locateTicketMessage', { name: ticket.title })" :disabled="!lastMessageByTicket.has(ticket.id)" @click="locateTicket(ticket.id)">
                      <MapPin :size="16" :stroke-width="1.75" aria-hidden="true" />
                    </UiButton>
                    <UiButton v-if="!group.archived && canChangeTicketArchive(ticket)" variant="ghost" size="icon"
                      :class="touchWorkspace && 'min-h-11 min-w-11'"
                      :label="t('superAgent.archiveTicket') + ' · ' + ticket.title" :disabled="busy" @click="chooseArchive(ticket)">
                      <Archive :size="16" :stroke-width="1.75" aria-hidden="true" />
                    </UiButton>
                  </div>
                </div>
              </component>
            </template>
            <div v-if="standaloneFollowUpRuns.length" data-ticket-runs-section :class="tickets.size > 0 && 'mt-2 border-t border-ui-border pt-2'">
              <div class="pb-1 text-xs font-medium text-ui-text-muted">{{ t("superAgent.followUp.runsHeading", { count: standaloneFollowUpRuns.length }) }}</div>
              <div v-for="run in standaloneFollowUpRuns" :key="run.id" :data-ticket-run="run.id" class="flex items-start gap-1">
                <details class="min-w-0 flex-1 break-words py-1.5">
                  <summary :class="touchWorkspace && 'min-h-11 py-2'" class="cursor-pointer text-sm font-medium">
                    {{ run.scheduleTitle ?? run.sourceId }}
                    <small class="text-ui-text-muted">{{ runStatusLabel(run.status) }}</small>
                    <small v-if="run.finishedAt || run.startedAt" class="ml-1 font-normal text-ui-text-faint">{{ formatRunTime(run.finishedAt ?? run.startedAt) }}</small>
                  </summary>
                  <p class="my-1 text-[11px] text-ui-text-muted">
                    {{ t(run.sourceKind === 'schedule' ? 'superAgent.followUp.fromSchedule' : 'superAgent.followUp.fromSession', { title: run.scheduleTitle ?? run.sourceId }) }}
                    <template v-if="run.provider"> · {{ providerName(run.provider) }}</template>
                  </p>
                  <p class="my-1.5 select-text whitespace-pre-wrap text-sm">{{ run.summary }}</p>
                  <p v-if="run.detail && run.detail.trim() !== run.summary.trim()" data-ticket-run-detail class="my-1.5 select-text whitespace-pre-wrap rounded border border-ui-border px-2 py-1.5 text-xs text-ui-text-muted">{{ run.detail }}</p>
                  <p v-else-if="run.error && !run.summary.includes(run.error)" class="my-1 select-text whitespace-pre-wrap text-xs text-ui-danger">{{ run.error }}</p>
                  <p v-if="run.evidenceAvailability !== 'available'" class="my-1 text-[11px] text-ui-text-faint">{{ evidenceAvailabilityLabel(run.evidenceAvailability) }}</p>
                  <div class="flex flex-wrap items-center gap-x-3 text-xs text-ui-accent" :class="touchWorkspace && 'workspace-touch-actions'">
                    <RouterLink v-if="run.sessionId && run.evidenceAvailability !== 'deleted'" :to="sessionRoute(run.sessionId)" data-ticket-run-open-session class="inline-flex items-center">{{ t('superAgent.openSession') }}</RouterLink>
                    <RouterLink v-if="run.scheduleId" :to="scheduleRoute(run.scheduleId)" data-ticket-run-open-schedule class="inline-flex items-center">{{ t('superAgent.followUp.openSchedule') }}</RouterLink>
                  </div>
                </details>
                <div class="mt-0.5 flex shrink-0 items-center">
                  <UiButton variant="ghost" size="icon" :class="touchWorkspace && 'min-h-11 min-w-11'"
                    data-ticket-run-locate
                    :label="t('superAgent.followUp.locateRunMessage', { name: run.scheduleTitle ?? run.sourceId })"
                    :disabled="!(run.deliveredMessageId && byId.has(run.deliveredMessageId))"
                    @click="run.deliveredMessageId && locateMessage(run.deliveredMessageId)">
                    <MapPin :size="16" :stroke-width="1.75" aria-hidden="true" />
                  </UiButton>
                </div>
              </div>
              <UiButton v-if="followUpRunsCursor" type="button" size="sm" class="mt-2" :loading="followUpRunsLoading" @click="loadFollowUpRuns(true)">{{ t("superAgent.followUp.loadMore") }}</UiButton>
            </div>
            <p v-if="followUpError" role="alert" class="my-1 text-xs text-ui-danger">{{ followUpError }}</p>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </template>
  </PaneHeader>
  <ConfirmDialog v-if="confirmingArchive" :title="t(confirmingArchive.archive ? 'superAgent.archiveTicket' : 'superAgent.restoreTicket') + ' · ' + confirmingArchive.ticket.title"
    :description="archiveDescription" :confirm-label="t(confirmingArchive.archive ? 'superAgent.archiveTicket' : 'superAgent.restoreTicket')" :confirm-disabled="busy"
    :tone="confirmingArchive.archive && confirmingArchive.ticket.workerContext === 'worktree' ? 'danger' : 'primary'" :confirm="confirmArchive" @close="confirmingArchive = undefined" />
  <ConfirmDialog
    v-if="confirmingReEdit"
    :title="t('superAgent.reEdit.confirmStashTitle')"
    :description="t('superAgent.reEdit.confirmStashDescription')"
    :confirm-label="t('superAgent.reEdit.confirmStashAction')"
    :confirm-disabled="sending"
    tone="primary"
    :confirm="confirmStashAndReEdit"
    @close="onConfirmReEditClose"
  />
  <UiDialog v-if="confirmingAbandonReEdit" v-slot="{ close }" :title="t('superAgent.reEdit.confirmAbandonTitle')" class="w-[26rem] max-w-[90vw] p-4" @close="confirmingAbandonReEdit = false">
    <h2 class="ui-dialog-title">{{ t("superAgent.reEdit.confirmAbandonTitle") }}</h2>
    <p class="ui-dialog-description">{{ t("superAgent.reEdit.confirmAbandonDescription") }}</p>
    <div class="mt-4 flex flex-wrap justify-end gap-2">
      <UiButton type="button" variant="ghost" size="sm" data-reedit-continue @click="close()">{{ t("superAgent.reEdit.continueEditing") }}</UiButton>
      <UiButton type="button" size="sm" data-reedit-keep-current @click="resolveAbandonReEdit('keep-as-draft')">{{ t("superAgent.reEdit.keepCurrentAsDraft") }}</UiButton>
      <UiButton type="button" variant="primary" size="sm" data-reedit-restore-stashed @click="resolveAbandonReEdit('restore-stashed')">{{ t("superAgent.reEdit.restoreStashed") }}</UiButton>
    </div>
  </UiDialog>
  <div v-if="needsFollowUpConsent" data-follow-up-consent-banner role="region" class="mx-auto flex w-full max-w-3xl shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ui-border px-6 py-2.5 text-xs">
    <span class="text-ui-text-muted">{{ pendingAuthScheduleCount > 0 ? t("superAgent.followUp.pendingAuthPrompt", { machine: machineName, count: pendingAuthScheduleCount }, pendingAuthScheduleCount) : t("superAgent.followUp.consentPrompt", { machine: machineName }) }}</span>
    <UiButton type="button" size="sm" variant="primary" data-follow-up-consent-enable :loading="followUpBusy" @click="consentBackgroundFollowUp">{{ t("superAgent.followUp.takeoverAllLabel") }}</UiButton>
  </div>
  <div
    v-if="focusedTicket"
    data-ticket-focus-banner
    :data-focused-ticket-id="focusedTicket.id"
    role="region"
    :aria-label="t('superAgent.focusing', { name: focusedTicket.title })"
    class="mx-auto flex w-full max-w-3xl shrink-0 items-center justify-between gap-3 border-b border-ui-border bg-ui-canvas/95 px-6 py-2 text-xs"
  >
    <div class="flex min-w-0 items-center gap-2">
      <span class="truncate font-medium text-ui-text">{{ t('superAgent.focusing', { name: focusedTicket.title }) }}</span>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <span aria-hidden="true" class="text-ui-border">｜</span>
      <button
        type="button"
        data-ticket-focus-exit
        :class="touchWorkspace && 'min-h-11 px-2'"
        class="cursor-pointer font-medium text-ui-accent hover:underline"
        @click="exitTicketFocus(true)"
      >{{ t('superAgent.showAll') }}</button>
    </div>
  </div>
  <div class="relative flex min-h-0 flex-1">
    <UiScrollArea ref="scrollArea" fade="top" class="min-h-0 min-w-0 flex-1" content-class="flex min-h-full flex-col" data-session-scroll-area
      :viewport-attrs="{ 'data-session-scroll-viewport': '', onScroll: followScroll }">
      <div ref="transcript" class="mx-auto flex min-h-full w-full max-w-3xl flex-1 flex-col px-6 py-6">
        <p v-if="!snapshot && !error && !offlineMachine" role="status" class="m-auto text-sm text-ui-text-muted">{{ t('agent.loading') }}</p>
        <h1 v-else-if="snapshot && !messages.length" class="m-auto text-center text-2xl font-medium tracking-tight">{{ t('superAgent.empty', { name }) }}</h1>
        <div v-else-if="focusedTicket && !displayedRows.length" data-ticket-focus-empty role="status" class="m-auto flex flex-col items-center gap-2 text-center text-sm text-ui-text-muted">
          <p class="m-0">{{ t('superAgent.focusEmpty', { name: focusedTicket.title }) }}</p>
          <UiButton type="button" size="sm" variant="ghost" @click="exitTicketFocus(true)">{{ t('superAgent.showAll') }}</UiButton>
        </div>
        <ol v-else class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
          <template v-for="entry in transcriptEntries" :key="entry.kind === 'foldedStoppedTurn' ? `folded:${entry.id}` : entry.id">
            <li
              v-if="entry.kind === 'foldedStoppedTurn'"
              :data-folded-stopped-turn="entry.id"
              :data-folded-stopped-reason="entry.reason"
              :data-outline-source="entry.id"
              class="min-w-0"
            >
              <button
                type="button"
                data-folded-stopped-toggle
                :aria-expanded="entry.reason === 'superseded' && expandedSupersededTurns.has(entry.id)"
                :class="touchWorkspace && 'min-h-11'"
                class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-sm text-ui-text-muted hover:text-ui-text"
                @click="toggleFoldedStoppedTurn(entry)"
              >
                <ChevronRight
                  :size="14"
                  class="shrink-0 ui-motion"
                  :class="entry.reason === 'superseded' && expandedSupersededTurns.has(entry.id) && 'rotate-90'"
                  aria-hidden="true"
                />
                <span>{{ t(entry.reason === 'superseded' ? 'superAgent.reEdit.supersededSummary' : 'superAgent.reEdit.manualFoldedSummary') }}</span>
              </button>
            </li>
          <template v-for="group in entryGroups(entry)" :key="group.id">
            <li v-if="group.approvals" :data-approval-history="group.id" :data-folded-history-member="entry.kind === 'foldedStoppedTurn' ? entry.id : undefined" :data-outline-source="sourceForOutline(group.rows[0]?.message)" class="min-w-0" :class="entry.kind === 'foldedStoppedTurn' && 'border-l-2 border-ui-border/70 pl-3 opacity-90'">
              <button type="button" :aria-expanded="expandedApprovals.has(group.id)" :title="group.rows[0]?.ticket?.title"
                :class="touchWorkspace && 'min-h-11'" class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-sm text-ui-text-muted hover:text-ui-text"
                @click="toggleApprovals(group.id)">
                <ChevronRight :size="14" class="shrink-0 ui-motion" :class="expandedApprovals.has(group.id) && 'rotate-90'" aria-hidden="true" />
                {{ t(group.approvals === 'handled' ? 'superAgent.approvalsHandled' : 'superAgent.approvalsRecorded', { count: group.rows.length }, group.rows.length) }}
              </button>
            </li>
          <template v-for="row in (!group.approvals || expandedApprovals.has(group.id) ? group.rows : [])" :key="row.message.id">
            <li :data-super-message="row.message.id" :data-folded-history-member="entry.kind === 'foldedStoppedTurn' ? entry.id : undefined" :data-conversation-located="locatedMessage === row.message.id || undefined" :data-outline-source="sourceForOutline(row.message)" :data-conversation-entry="row.message.role === 'user' ? row.message.id : undefined" class="min-w-0 scroll-mt-6"
              :class="[{ 'workspace-touch-actions': touchWorkspace, 'ui-conversation-history': !row.progress && row.message.id !== displayedRows.at(-1)?.message.id && details !== row.message.id && activeEntry !== row.message.id && locatedMessage !== row.message.id, 'ui-conversation-input': row.message.role === 'user' }, entry.kind === 'foldedStoppedTurn' && 'border-l-2 border-ui-border/70 pl-3 opacity-90']">
              <WorkspaceMessage :assistant-name="assistantDisplayName" :accent-tickets="row.linkedTickets" :resource-target="row.message.role === 'worker' ? resourceTarget : undefined" :read-attachment="readAttachment" :message="row.message" :touch="touchWorkspace" :animate-send="row.message.id === lastUserMessage" :can-fork="!!row.fork && supportsFork(row.fork.sessionId)" :fork-disabled="!!offlineMachine" :can-locate-previous="touchWorkspace && row.message.role === 'user' && !!previousUserMessageId(displayedRows, row.message.id)"
                @quote="quote(row.message)" @fork="row.fork && openFork(row.fork.sessionId, row.fork.turnId)" @avatar-dblclick="locatePreviousUserMessage(row.message.id)" @locate-previous="locatePreviousUserMessage(row.message.id)">
                <template #heading>
                  <button
                    v-if="row.linkedTickets.length || runInfoByMessageId.get(row.message.id) || row.jobs.length || visibleSessionsFor(row.sessions, runInfoByMessageId.get(row.message.id)).length || canAttributeMessage(row.message)"
                    type="button"
                    data-execution-toggle
                    :data-sa-accent-slot="row.linkedTickets.length === 1 ? accentSlotOfTicket(row.linkedTickets[0]) : undefined"
                    :class="[
                      touchWorkspace && 'min-h-11',
                      row.linkedTickets.length > 1
                        ? 'flex-wrap gap-x-1 gap-y-0.5 text-ui-text-muted'
                        : row.linkedTickets.length === 1 && accentSlotOfTicket(row.linkedTickets[0]) !== undefined
                          ? 'gap-0.5 sa-ticket-accent sa-ticket-label'
                          : 'gap-0.5 text-ui-accent',
                    ]"
                    class="inline-flex min-w-0 max-w-full cursor-pointer items-center hover:underline"
                    :aria-expanded="details === row.message.id"
                    @click="toggleDetails(row.message.id)"
                  >
                    <template v-if="row.linkedTickets.length > 1">
                      <template v-for="(linked, idx) in row.linkedTickets" :key="linked.id">
                        <span v-if="idx > 0" aria-hidden="true" class="text-ui-text-faint">/</span>
                        <span
                          data-sa-ticket-label
                          :data-sa-ticket-id="linked.id"
                          :data-sa-accent-slot="accentSlotOfTicket(linked)"
                          :title="linked.title"
                          class="max-w-[11rem] truncate"
                          :class="accentSlotOfTicket(linked) !== undefined ? 'sa-ticket-accent sa-ticket-label' : 'text-ui-accent'"
                        >{{ linked.title }}</span>
                      </template>
                    </template>
                    <span
                      v-else-if="row.linkedTickets.length === 1"
                      data-sa-ticket-label
                      :data-sa-ticket-id="row.linkedTickets[0]!.id"
                      :data-sa-accent-slot="accentSlotOfTicket(row.linkedTickets[0])"
                      :title="row.linkedTickets[0]!.title"
                      class="max-w-[16rem] truncate"
                    >{{ row.linkedTickets[0]!.title || t('superAgent.ticketDetails') }}</span>
                    <template v-else>{{ runInfoByMessageId.get(row.message.id)?.title ?? (visibleSessionsFor(row.sessions, undefined).length ? t('superAgent.ticketDetails') : t('superAgent.linkToTicket')) }}</template>
                    <ChevronDown :size="12" class="shrink-0" :class="details === row.message.id && 'rotate-180'" aria-hidden="true" />
                  </button>
                </template>
                <template #before>
                  <div v-if="details === row.message.id" data-execution-details class="mb-2 rounded-lg border border-ui-border px-3 py-2 text-xs">
                    <template v-if="runInfoByMessageId.get(row.message.id)">
                      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-ui-text-muted">
                        <span v-if="runInfoByMessageId.get(row.message.id)!.provider" class="font-medium text-ui-text">{{ providerName(runInfoByMessageId.get(row.message.id)!.provider!) }}</span>
                        <span v-if="runInfoByMessageId.get(row.message.id)!.status"><template v-if="runInfoByMessageId.get(row.message.id)!.provider"> · </template>{{ runStatusLabel(runInfoByMessageId.get(row.message.id)!.status) }}</span>
                        <span v-if="runInfoByMessageId.get(row.message.id)!.sourceTitle"> · {{ t(runInfoByMessageId.get(row.message.id)!.sourceKind === 'schedule' ? 'superAgent.followUp.fromSchedule' : 'superAgent.followUp.fromSession', { title: runInfoByMessageId.get(row.message.id)!.sourceTitle! }) }}</span>
                        <time v-if="runInfoByMessageId.get(row.message.id)!.timestamp" :datetime="runInfoByMessageId.get(row.message.id)!.timestamp"> · {{ formatRunTime(runInfoByMessageId.get(row.message.id)!.timestamp) }}</time>
                      </div>
                      <p v-if="row.ticket?.scope" class="my-1 select-text whitespace-pre-wrap text-ui-text-muted">{{ row.ticket.scope }}</p>
                      <p v-if="runInfoByMessageId.get(row.message.id)!.detail" data-execution-detail-body class="my-1.5 select-text whitespace-pre-wrap text-ui-text">{{ runInfoByMessageId.get(row.message.id)!.detail }}</p>
                      <p v-else-if="runInfoByMessageId.get(row.message.id)!.error" data-execution-detail-body class="my-1.5 select-text whitespace-pre-wrap text-ui-danger">{{ runInfoByMessageId.get(row.message.id)!.error }}</p>
                      <p v-if="runInfoByMessageId.get(row.message.id)!.evidenceAvailability !== 'available'" class="my-1 text-[11px] text-ui-text-faint">{{ evidenceAvailabilityLabel(runInfoByMessageId.get(row.message.id)!.evidenceAvailability) }}</p>
                    </template>
                    <template v-else-if="row.ticket">
                      <span v-if="hasTicketStatus(row.ticket.status)">{{ t(`superAgent.status.${row.ticket.status}`) }}<template v-if="row.ticket.provider"> · </template></span><span v-if="row.ticket.provider">{{ providerName(row.ticket.provider) }}</span>
                      <p class="my-1 select-text whitespace-pre-wrap">{{ row.ticket.scope }}</p>
                      <p v-if="row.ticket.latestAcceptance" class="my-1 select-text whitespace-pre-wrap text-sm">{{ t('superAgent.acceptance', { text: row.ticket.latestAcceptance }) }}</p>
                      <p v-if="row.detailSummary" class="my-1 select-text whitespace-pre-wrap text-ui-text-muted">{{ progressText(row.detailSummary) }}</p>
                    </template>
                    <template v-else-if="row.linkedTickets.length > 1">
                      <ul class="m-0 mb-1.5 flex list-none flex-col gap-1 p-0">
                        <li v-for="linked in row.linkedTickets" :key="linked.id" class="flex flex-wrap items-center gap-1.5">
                          <span
                            :data-sa-ticket-id="linked.id"
                            :data-sa-accent-slot="accentSlotOfTicket(linked)"
                            :title="linked.title"
                            :class="accentSlotOfTicket(linked) !== undefined ? 'sa-ticket-accent sa-ticket-label' : 'font-medium text-ui-text'"
                          >{{ linked.title }}</span>
                        </li>
                      </ul>
                    </template>
                    <p v-if="row.message.reason && row.message.state !== 'failed' && row.message.state !== 'uncertain'" class="my-1 select-text whitespace-pre-wrap text-ui-text-muted">{{ row.message.reason }}</p>
                    <div :class="touchWorkspace && 'workspace-touch-actions'" class="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <RouterLink v-for="session in visibleSessionsFor(row.sessions, runInfoByMessageId.get(row.message.id))" :key="session.id" :to="sessionRoute(session.id)" data-message-open-session class="inline-flex items-center text-ui-accent">{{ session.title ? t('superAgent.openTicketSession', { name: session.title }) : t('superAgent.openSession') }}</RouterLink>
                      <RouterLink v-if="runInfoByMessageId.get(row.message.id)?.scheduleId" :to="scheduleRoute(runInfoByMessageId.get(row.message.id)!.scheduleId!)" data-message-open-schedule class="inline-flex items-center text-ui-accent">{{ t('superAgent.followUp.openSchedule') }}</RouterLink>
                      <button
                        v-if="row.linkedTickets.length > 0 && (canEditMessageLinks(row.message) || canCorrect(row.message)) && correcting !== row.message.id"
                        type="button"
                        data-message-edit-attribution
                        class="text-ui-accent"
                        @click="openAttributionEditor(row.message.id)"
                      >{{ t('superAgent.correct') }}</button>
                      <button
                        v-else-if="row.linkedTickets.length === 0 && (canEditMessageLinks(row.message) || canCorrect(row.message)) && correcting !== row.message.id"
                        type="button"
                        data-message-link-ticket
                        class="text-ui-accent"
                        @click="openAttributionEditor(row.message.id)"
                      >{{ t('superAgent.linkToTicket') }}</button>
                      <button
                        v-if="canCreateTicketFor(row.message) && creatingTicketFor !== row.message.id"
                        type="button"
                        data-message-create-ticket
                        class="text-ui-accent"
                        @click="openCreateTicketForm(row.message)"
                      >{{ t('superAgent.createTicket') }}</button>
                    </div>
                    <form v-if="correcting === row.message.id && canEditMessageLinks(row.message)" data-link-tickets-form class="mt-2 flex flex-col gap-2" @submit.prevent="applyLinkEdit(row.message.id)">
                      <div v-if="linkableTicketsFor(row.message.id).length" class="flex flex-col gap-1">
                        <label
                          v-for="item in linkableTicketsFor(row.message.id)"
                          :key="item.id"
                          class="flex cursor-pointer items-center gap-2 text-xs text-ui-text"
                        >
                          <input
                            type="checkbox"
                            :value="item.id"
                            :checked="selectedLinkTickets.includes(item.id)"
                            :data-link-ticket-option="item.id"
                            @change="toggleLinkSelection(item.id)"
                          />
                          <span
                            :data-sa-accent-slot="accentSlotOfTicket(item)"
                            class="truncate"
                            :class="accentSlotOfTicket(item) !== undefined ? 'sa-ticket-accent sa-ticket-label' : undefined"
                          >{{ item.title }}</span>
                        </label>
                      </div>
                      <p v-else class="m-0 text-ui-text-muted">{{ t('superAgent.noTicketsAvailable') }}</p>
                      <div class="flex flex-wrap items-center gap-2">
                        <UiButton v-if="linkableTicketsFor(row.message.id).length" type="submit" size="sm" data-link-tickets-apply :disabled="busy">{{ t('superAgent.apply') }}</UiButton>
                        <UiButton v-if="row.linkedTickets.length > 0" type="button" variant="ghost" size="sm" data-link-tickets-clear :disabled="busy" @click="clearLinkEdit(row.message.id)">{{ t('superAgent.clearAttribution') }}</UiButton>
                        <UiButton type="button" variant="ghost" size="sm" @click="correcting = undefined">{{ t('catalog.cancel') }}</UiButton>
                      </div>
                    </form>
                    <form v-else-if="correcting === row.message.id" class="mt-2 flex flex-wrap gap-2" @submit.prevent="applyCorrection">
                      <select v-model="target" :aria-label="t('superAgent.targetTicket')" class="max-w-full rounded border border-ui-border bg-ui-canvas p-1 text-sm">
                        <option value="" disabled>{{ t('superAgent.targetTicket') }}</option><option v-for="item in correctionChoices" :key="item.id" :value="item.id">{{ item.title }}</option>
                      </select>
                      <UiButton type="submit" size="sm" :disabled="!target || busy">{{ t('superAgent.apply') }}</UiButton>
                      <UiButton variant="ghost" size="sm" @click="correcting = undefined">{{ t('catalog.cancel') }}</UiButton>
                    </form>
                    <form v-if="creatingTicketFor === row.message.id" data-create-ticket-form class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="applyCreateTicket(row.message.id)">
                      <input
                        v-model="newTicketTitle"
                        type="text"
                        maxlength="200"
                        data-create-ticket-title
                        :aria-label="t('superAgent.createTicketTitle')"
                        :placeholder="t('superAgent.createTicketPlaceholder')"
                        class="min-w-44 flex-1 rounded border border-ui-border bg-ui-canvas px-2 py-1 text-xs text-ui-text"
                      />
                      <UiButton type="submit" size="sm" data-create-ticket-submit :disabled="!newTicketTitle.trim() || busy">{{ t('superAgent.createTicket') }}</UiButton>
                      <UiButton type="button" variant="ghost" size="sm" @click="creatingTicketFor = undefined">{{ t('catalog.cancel') }}</UiButton>
                    </form>
                  </div>
                  <WorkspaceMessageQuote
                    v-if="row.message.replyTo && replyQuote(row.message.replyTo)"
                    :reply-to="row.message.replyTo"
                    :text="replyQuote(row.message.replyTo)!.text"
                    :locatable="replyQuote(row.message.replyTo)!.locatable"
                    :accent-slot="replyQuote(row.message.replyTo)!.accentSlot"
                    :touch="touchWorkspace"
                    @locate="locateMessage"
                  />
                </template>
                <template v-if="entry.kind !== 'foldedStoppedTurn' && stoppedActionSourceForWorkerResult(row.message)" #stopped-actions>
                  <WorkspaceStoppedActions
                    :source-message-id="stoppedActionSourceForWorkerResult(row.message)!"
                    :touch="touchWorkspace"
                    :re-edit-disabled="sending"
                    @re-edit="requestReEdit(stoppedActionSourceForWorkerResult(row.message)!)"
                    @fold="foldStoppedTurn(stoppedActionSourceForWorkerResult(row.message)!)"
                  />
                </template>
                <div v-if="visibleProgressFor(row.progress) && row.message.role !== 'user'" class="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <WorkspaceReplyProgress :progress="visibleProgressFor(row.progress)!" :supports-stop="supportsStop" :disabled="stopDisabled" :unreachable="stopUnreachable" :feedback="row.message.sourceMessageId ? visibleFeedbackFor(feedbackMap.get(row.message.sourceMessageId)) : undefined" :tickets="tickets" :fallback-tickets="row.linkedTickets" :touch="touchWorkspace" :on-load-process="loadProcess" @stop="stop" />
                  <WorkspaceStoppedActions
                    v-if="entry.kind !== 'foldedStoppedTurn' && stoppedActionSourceForProgress(row.message.id)"
                    :source-message-id="stoppedActionSourceForProgress(row.message.id)!"
                    :touch="touchWorkspace"
                    :re-edit-disabled="sending"
                    @re-edit="requestReEdit(stoppedActionSourceForProgress(row.message.id)!)"
                    @fold="foldStoppedTurn(stoppedActionSourceForProgress(row.message.id)!)"
                  />
                </div>
                <div v-if="row.message.workerEvent === 'result' && (row.message.truncated || row.message.unboundedOutcome) && row.message.sessionId" class="mt-1 text-xs">
                  <RouterLink :to="sessionRoute(row.message.sessionId)" data-open-full-worker class="inline-flex items-center text-ui-accent no-underline hover:underline">{{ t('superAgent.openSession') }}</RouterLink>
                </div>
                <details v-if="row.message.context" class="mt-1 break-words text-xs text-ui-text-muted">
                  <summary class="cursor-pointer">{{ row.message.sourceWorkspaceId === undefined ? t('superAgent.context') : t('superAgent.fromWorkspace', { name: conversationName(row.message.sourceWorkspaceId) }) }}</summary>
                  <p class="my-1 select-text whitespace-pre-wrap">{{ row.message.context }}</p>
                </details>
                <ul v-if="row.jobs.length > 1" class="m-0 mt-2 flex list-none flex-col gap-1.5 p-0 text-xs text-ui-text-muted">
                  <li v-for="job in row.jobs" :key="job.ticket.id" class="flex flex-wrap items-center gap-x-2">
                    <span
                      :data-sa-ticket-id="job.ticket.id"
                      :data-sa-accent-slot="accentSlotOfTicket(job.ticket)"
                      :title="job.ticket.title"
                      class="max-w-[14rem] truncate"
                      :class="accentSlotOfTicket(job.ticket) !== undefined ? 'sa-ticket-accent sa-ticket-label' : 'font-medium text-ui-text'"
                    >{{ job.ticket.title }}</span>
                    <span v-if="job.delivery && (row.workerFailure || row.message.state === 'uncertain')">{{ missingWorker(job.delivery) ? t('superAgent.actions.workerNotStarted') : job.delivery.text }}</span>
                    <UiButton size="icon" variant="ghost" :label="t('superAgent.actions.quoteTicket', { name: job.ticket.title })" @click="quote(job.marker)"><CornerUpLeft :size="13" aria-hidden="true" /></UiButton>
                  </li>
                </ul>
                <div v-if="row.workerFailure && !row.perTicketFailures" class="mt-1 text-xs text-ui-text-muted" role="status">
                  {{ row.workerMissing ? t('superAgent.actions.workerNotStarted') : t('superAgent.actions.workerFailed') }}<template v-if="!row.workerMissing && row.message.reason"> {{ row.message.reason }}</template>
                </div>
                <div v-else-if="row.message.failureCode === 'coordinator_unconfigured'" class="mt-1 text-xs text-ui-text-muted" role="status">{{ t('superAgent.coordinatorUnavailable') }}</div>
                <div v-else-if="!row.workerFailure && (row.message.state === 'uncertain' || row.message.state === 'failed')" class="mt-1 text-xs text-ui-text-muted" role="status">{{ t(`superAgent.state.${row.message.state}`) }}<template v-if="row.message.reason && !(row.message.state === 'uncertain' && row.perTicketFailures)"> {{ row.message.reason }}</template></div>
                <div v-if="row.workerMissing || row.message.retryable || row.message.targetWorkspaceId" :class="touchWorkspace && 'workspace-touch-actions'" class="mt-1 flex flex-wrap items-center gap-3 text-xs text-ui-text-muted">
                  <button v-if="row.workerMissing && workers.length" type="button" class="text-ui-accent" @click="showSettings = true">{{ t('superAgent.actions.chooseWorker') }}</button>
                  <RouterLink v-else-if="row.workerMissing" :to="{ name: 'settings-agents' }" class="text-ui-accent">{{ t('superAgent.actions.configureWorker') }}</RouterLink>
                  <button v-else-if="row.message.role === 'user' && row.message.retryable && !row.workerFailure" type="button" class="hover:text-ui-accent" @click="showSettings = true">{{ t('superAgent.switchHint') }}</button>
                  <button v-if="row.message.role === 'user' && row.message.retryable" type="button" :disabled="busy || (row.workerMissing && !workers.length)" class="text-ui-accent disabled:text-ui-text-muted" @click="retry(row.message)">{{ t(row.workerFailure ? 'superAgent.actions.retryWorker' : 'errors.retry') }}</button>
                  <button v-if="row.message.targetWorkspaceId" type="button" class="inline-flex items-center gap-1 text-ui-accent" @click="goToProject(row.message.targetWorkspaceId)">{{ t('superAgent.openWorkspace', { name: workspaceName(row.message.targetWorkspaceId) }) }}<ArrowRight :size="12" aria-hidden="true" /></button>
                  <RouterLink v-if="!runInfoByMessageId.get(row.message.id) && row.message.provenance?.scheduleId" :to="scheduleRoute(row.message.provenance.scheduleId)" data-message-open-schedule class="inline-flex items-center text-ui-accent no-underline hover:underline">{{ t('superAgent.followUp.openSchedule') }}</RouterLink>
                  <RouterLink v-if="!runInfoByMessageId.get(row.message.id) && row.message.provenance?.sessionId && row.message.provenance.evidenceAvailability !== 'deleted'" :to="sessionRoute(row.message.provenance.sessionId)" data-message-open-session class="inline-flex items-center text-ui-accent no-underline hover:underline">{{ t('superAgent.openSession') }}</RouterLink>
                </div>
                <div v-else-if="!runInfoByMessageId.get(row.message.id) && (row.message.provenance?.scheduleId || row.message.provenance?.sessionId)" :class="touchWorkspace && 'workspace-touch-actions'" class="mt-1 flex flex-wrap items-center gap-3 text-xs text-ui-text-muted">
                  <span v-if="row.message.provenance.scheduleTitle">{{ t(row.message.provenance.sourceKind === 'schedule' ? 'superAgent.followUp.fromSchedule' : 'superAgent.followUp.fromSession', { title: row.message.provenance.scheduleTitle }) }}</span>
                  <RouterLink v-if="row.message.provenance.scheduleId" :to="scheduleRoute(row.message.provenance.scheduleId)" data-message-open-schedule class="inline-flex items-center text-ui-accent no-underline hover:underline">{{ t('superAgent.followUp.openSchedule') }}</RouterLink>
                  <RouterLink v-if="row.message.provenance.sessionId && row.message.provenance.evidenceAvailability !== 'deleted'" :to="sessionRoute(row.message.provenance.sessionId)" data-message-open-session class="inline-flex items-center text-ui-accent no-underline hover:underline">{{ t('superAgent.openSession') }}</RouterLink>
                  <span v-if="row.message.provenance.evidenceAvailability && row.message.provenance.evidenceAvailability !== 'available'">{{ evidenceAvailabilityLabel(row.message.provenance.evidenceAvailability) }}</span>
                </div>
              </WorkspaceMessage>
            </li>
            <li
              v-if="hasVisibleFeedbackGroup(row)"
              :data-feedback-group-for="row.message.id"
              :data-folded-history-member="entry.kind === 'foldedStoppedTurn' ? entry.id : undefined"
              :data-outline-source="row.message.id"
              :aria-label="assistantDisplayName"
              class="mr-auto flex min-w-0 max-w-full flex-col gap-2"
              :class="[{ 'workspace-touch-actions': touchWorkspace }, entry.kind === 'foldedStoppedTurn' && 'border-l-2 border-ui-border/70 pl-3 opacity-90']"
            >
              <div
                v-if="visibleProgressFor(row.progress) || visibleFeedbackFor(row.feedback)?.ack || visibleFeedbackFor(row.feedback)?.milestones.length || visibleFeedbackFor(row.feedback)?.finalPreviews.length"
                class="flex items-center gap-1 text-xs text-ui-text-muted"
              >
                <span
                  v-if="feedbackGroupAccentSlot(row) !== undefined"
                  data-sa-role-dot
                  :data-sa-accent-slot="feedbackGroupAccentSlot(row)"
                  aria-hidden="true"
                  class="sa-ticket-accent sa-ticket-dot"
                >·</span>
                <span data-sa-role-name>{{ assistantDisplayName }}</span>
              </div>
              <div
                v-if="visibleFeedbackFor(row.feedback)?.ack"
                :data-feedback-ack="visibleFeedbackFor(row.feedback)!.ack!.itemId"
                :data-conversation-located="locatedMessage === visibleFeedbackFor(row.feedback)!.ack!.itemId || undefined"
                class="group flex min-w-0 scroll-mt-6 flex-col items-start gap-1.5"
              >
                <div v-if="attributedTicketsForFeedbackItem(visibleFeedbackFor(row.feedback)!.ack!, row.linkedTickets).length" class="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-ui-text-muted">
                  <template v-for="(ackTicket, idx) in attributedTicketsForFeedbackItem(visibleFeedbackFor(row.feedback)!.ack!, row.linkedTickets)" :key="ackTicket.id">
                    <span v-if="idx > 0" aria-hidden="true" class="text-ui-text-faint">/</span>
                    <span
                      data-sa-ticket-label
                      :data-sa-ticket-id="ackTicket.id"
                      :data-sa-accent-slot="accentSlotOfTicket(ackTicket)"
                      :title="ackTicket.title"
                      class="max-w-[14rem] truncate"
                      :class="accentSlotOfTicket(ackTicket) !== undefined ? 'sa-ticket-accent sa-ticket-label' : 'font-medium text-ui-text-muted'"
                    >{{ ackTicket.title }}</span>
                  </template>
                </div>
                <AgentContent class="max-w-full" :content="[{ type: 'text', text: visibleFeedbackFor(row.feedback)!.ack!.text }]" markdown :final="visibleFeedbackFor(row.feedback)!.ack!.status !== 'streaming'" />
                <AgentMessageActions :text="visibleFeedbackFor(row.feedback)!.ack!.text" :always-visible="touchWorkspace" can-quote @quote="quote({ id: visibleFeedbackFor(row.feedback)!.ack!.itemId })" />
              </div>
              <div
                v-for="milestone in visibleFeedbackFor(row.feedback)?.milestones ?? []"
                :key="milestone.itemId"
                :data-feedback-milestone="milestone.itemId"
                :data-conversation-located="locatedMessage === milestone.itemId || undefined"
                :data-feedback-status="milestone.status"
                class="group flex min-w-0 scroll-mt-6 flex-col items-start gap-1.5 border-l-2 border-ui-border pl-3"
              >
                <div class="flex flex-wrap items-center gap-2 text-xs text-ui-text-muted">
                  <span>{{ t("superAgent.feedback.milestone") }}</span>
                  <span
                    v-if="milestone.ticketId && tickets.get(milestone.ticketId)"
                    data-sa-ticket-label
                    :data-sa-ticket-id="milestone.ticketId"
                    :data-sa-accent-slot="accentSlotOfTicket(tickets.get(milestone.ticketId))"
                    :title="tickets.get(milestone.ticketId)!.title"
                    class="max-w-[14rem] truncate"
                    :class="accentSlotOfTicket(tickets.get(milestone.ticketId)) !== undefined ? 'sa-ticket-accent sa-ticket-label' : 'font-medium text-ui-text-muted'"
                  >{{ tickets.get(milestone.ticketId)!.title }}</span>
                  <RouterLink v-if="milestone.sessionId" :to="sessionRoute(milestone.sessionId)" class="text-ui-accent no-underline hover:underline">{{ t("superAgent.openSession") }}</RouterLink>
                </div>
                <AgentContent class="max-w-full" :content="[{ type: 'text', text: milestone.text }]" markdown :final="milestone.status !== 'streaming'" />
                <p v-if="milestone.status === 'aborted'" data-milestone-aborted role="status" class="m-0 text-xs text-ui-text-muted">{{ t("superAgent.feedback.draftAborted") }}</p>
                <AgentMessageActions :text="milestone.text" :always-visible="touchWorkspace" can-quote @quote="quote({ id: milestone.itemId })" />
              </div>
              <div
                v-for="preview in visibleFeedbackFor(row.feedback)?.finalPreviews ?? []"
                :key="preview.itemId"
                :data-feedback-final-preview="preview.itemId"
                :data-feedback-status="preview.status"
                class="flex min-w-0 flex-col items-start gap-1.5"
              >
                <span
                  v-if="preview.ticketId && tickets.get(preview.ticketId)"
                  data-sa-ticket-label
                  :data-sa-ticket-id="preview.ticketId"
                  :data-sa-accent-slot="accentSlotOfTicket(tickets.get(preview.ticketId))"
                  :title="tickets.get(preview.ticketId)!.title"
                  class="max-w-[14rem] truncate text-xs"
                  :class="accentSlotOfTicket(tickets.get(preview.ticketId)) !== undefined ? 'sa-ticket-accent sa-ticket-label' : 'font-medium text-ui-text-muted'"
                >{{ tickets.get(preview.ticketId)!.title }}</span>
                <AgentContent class="max-w-full" :content="[{ type: 'text', text: preview.text }]" markdown :final="preview.status !== 'streaming'" />
                <p v-if="preview.status === 'aborted'" data-draft-aborted role="status" class="m-0 text-xs text-ui-text-muted">{{ t("superAgent.feedback.draftAborted") }}</p>
                <p v-if="preview.truncated" data-excerpt-notice class="m-0 text-xs text-ui-text-muted">{{ t("superAgent.feedback.excerptNotice") }}</p>
                <RouterLink v-if="(preview.truncated || preview.status === 'aborted') && preview.sessionId" :to="sessionRoute(preview.sessionId)" class="text-xs text-ui-accent no-underline hover:underline">{{ t("superAgent.openSession") }}</RouterLink>
              </div>
              <div v-if="visibleProgressFor(row.progress)" class="flex flex-wrap items-start gap-x-3 gap-y-1">
                <WorkspaceReplyProgress
                  :progress="visibleProgressFor(row.progress)!"
                  :supports-stop="supportsStop"
                  :disabled="stopDisabled"
                  :unreachable="stopUnreachable"
                  :feedback="visibleFeedbackFor(row.feedback)"
                  :tickets="tickets"
                  :fallback-tickets="row.linkedTickets"
                  :touch="touchWorkspace"
                  :on-load-process="loadProcess"
                  @stop="stop"
                />
                <WorkspaceStoppedActions
                  v-if="entry.kind !== 'foldedStoppedTurn' && stoppedActionSourceForProgress(row.message.id)"
                  :source-message-id="row.message.id"
                  :touch="touchWorkspace"
                  :re-edit-disabled="sending"
                  @re-edit="requestReEdit(row.message.id)"
                  @fold="foldStoppedTurn(row.message.id)"
                />
              </div>
              <WorkspaceProgressDetails
                v-else-if="visibleFeedbackFor(row.feedback)?.hasProcess && !activeProgressSources.has(row.message.id)"
                :feedback="visibleFeedbackFor(row.feedback)!"
                :active="false"
                :tickets="tickets"
                :touch="touchWorkspace"
                :on-load="loadProcess"
              />
            </li>
          </template>
          </template>
          </template>
        </ol>
      </div>
    </UiScrollArea>
    <ReadingSpotlight />
    <AgentOutline v-if="outline.length" :entries="outline" :active="activeEntry" class="absolute left-1 top-1/2 z-20 max-h-[calc(100%-2rem)] -translate-y-1/2" @select="locateEntry" />
    <div v-if="snapshot && !stickToBottom" class="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center">
      <div class="relative mx-auto flex w-full max-w-3xl justify-end px-6">
        <UiButton type="button" size="icon" class="pointer-events-auto h-8 w-8 rounded-full border border-ui-border bg-ui-surface text-ui-text shadow-ui-popover" :label="t('agent.scrollToBottom')" data-scroll-to-bottom @click="scrollToBottom">
          <ArrowDown :size="16" :stroke-width="1.75" aria-hidden="true" />
        </UiButton>
      </div>
    </div>
  </div>
  <div v-if="snapshot?.pendingRequests?.length" class="mx-auto flex max-h-[36dvh] w-full max-w-3xl shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain px-6 py-2" :aria-label="t('agent.permissions')" role="region">
    <WorkspaceWorkerRequest v-for="request in snapshot.pendingRequests" :key="requestKey(request)"
      :request="request" :title="tickets.get(request.ticketId)?.title ?? request.sourceTitle" :disabled="!!offlineMachine || machinePresence?.online === false || canRefresh" @refresh="refresh" />
  </div>
  <div v-if="offlineMachine || error || unsupportedAttachments || missingAttachments.length" class="mx-auto w-full max-w-3xl shrink-0 px-6 pt-2">
    <p v-if="unsupportedAttachments" role="alert" class="mb-2 text-sm text-ui-danger">{{ t('superAgent.attachmentsUnsupported') }}</p>
    <div v-if="missingAttachments.length" role="alert" class="mb-2 text-sm text-ui-text-muted">
      <p>{{ t('superAgent.reselectAttachments') }}</p>
      <button v-for="file in missingAttachments" :key="file.id" type="button" class="mr-2 inline-flex items-center gap-1" :aria-label="t('composer.removeAttachment', { name: file.name ?? t('composer.pastedText') })" @click="discardMissing(file.id)">{{ file.name ?? t('composer.pastedText') }}<X :size="14" aria-hidden="true" /></button>
    </div>
    <p v-if="offlineMachine" role="status" class="mb-2 break-words text-sm text-ui-text-muted">{{ t('desktop.offline', { machine: offlineMachine.name }) }}</p>
    <p v-else-if="error" role="alert" class="mb-2 break-words text-sm text-ui-danger">{{ error }} <button v-if="canRefresh" type="button" class="text-ui-accent" @click="refresh">{{ t('errors.retry') }}</button><button v-if="canSendPlain" type="button" class="text-ui-accent" @click="send(true)">{{ t('superAgent.commands.sendText') }}</button></p>
  </div>
  <UiDialog v-if="choosingStop && stopChoices.length" v-slot="{ close }" :title="t('superAgent.stop.choose')" class="w-[26rem] max-w-[90vw] p-4" @close="choosingStop = false">
    <h2 class="mb-2 font-medium">{{ t('superAgent.stop.choose') }}</h2>
    <button v-for="choice in stopChoices" :key="choice.sourceId" type="button" :disabled="stopDisabled" class="ui-menu-item min-h-11 w-full justify-start" @click="close(); stop(choice)">
      <span class="min-w-0 truncate">{{ quoteText(byId.get(choice.sourceId)!) }}</span>
      <span v-if="stoppableSteps(choice).length > 1 || stoppableSteps(choice)[0]?.sharedTurn" class="shrink-0 text-xs">{{ stopLabel(choice) }}</span>
    </button>
    <UiButton variant="ghost" size="sm" @click="close">{{ t('catalog.cancel') }}</UiButton>
  </UiDialog>
  <SessionComposer ref="editor" v-model="draft.text" v-model:attachments="attachments" v-model:mentions="mentions" :workspace-agent="commandMenu" :location="location" :coordinator-usage="snapshot?.coordinatorUsage" :disabled="!snapshot || saving" :submitting="sending" :submit-blocked="!!offlineMachine || draft.text.trim() === '/' || unsupportedAttachments || !!missingAttachments.length" :can-cancel="!!stopChoices.length && !stopDisabled" :cancel-label="cancelLabel" @cancel="composerStop" @submit="submit">
    <template #before-input>
      <WorkspaceReEditBanner
        v-if="reEdit"
        :source-message-id="reEdit.sourceMessageId"
        :has-stashed-draft="hasStashedDraft"
        :disabled="sending"
        :touch="touchWorkspace"
        @cancel="handleCancelReEdit"
      />
      <div
        v-if="quoted"
        data-composer-quote
        :data-sa-quote-rail="quotedAccentSlot !== undefined ? 'true' : undefined"
        :data-sa-accent-slot="quotedAccentSlot"
        class="mx-3 mt-3 flex items-center gap-2 border-l-2 pl-2 text-xs text-ui-text-muted"
        :class="quotedAccentSlot !== undefined ? 'sa-ticket-accent sa-ticket-rail' : 'border-ui-accent'"
      >
        <span class="min-w-0 flex-1 truncate">{{ quoteText(quoted) }}</span>
        <button type="button" :aria-label="t('superAgent.clearQuote')" :class="touchWorkspace && 'inline-flex min-h-11 min-w-11 items-center justify-center -my-2 -mr-2'" @click="delete draft.replyTo"><X :size="14" aria-hidden="true" /></button>
      </div>
    </template>
    <template #toolbar>
      <ProjectModelMenu v-if="snapshot" v-model:open="showSettings" :touch="touchWorkspace" :save-error="error" :snapshot="snapshot" :workers="workers" :disabled="busy" :save="saveSettings" @refresh="refresh" />
    </template>
  </SessionComposer>
</template>

<style scoped>
.workspace-touch-actions :deep(button),
.workspace-touch-actions :deep(a) { min-height: 44px; min-width: 44px; }
.ui-conversation-history {
  content-visibility: auto;
  contain-intrinsic-block-size: auto 24rem;
}
.ui-conversation-history.ui-conversation-input {
  contain-intrinsic-block-size: auto 5rem;
}
@media print {
  .ui-conversation-history { content-visibility: visible; }
}
</style>
