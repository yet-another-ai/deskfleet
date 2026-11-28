import { useDocumentVisibility, useIntervalFn } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { DeskfleetDesktopApi, SuperFeedbackHandle } from "@deskfleet/client/desktop-api"
import { parseWorkerReference } from "@deskfleet/client/worker-reference"
import { adhdCommand } from "@deskfleet/protocol/adhd-command"
import { archivedTicketError, superWorkerCommandName, type SuperFeedbackPush, type SuperMessage, type SuperSettings, type SuperSnapshot, type SuperWorkerCommandTarget, type SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import { useWorkspaceCommands } from "./useWorkspaceCommands.ts"
import { createStoredWorkspaceAttachment, workspacePromptAttachments, workspaceReusedAttachments, type ComposerAttachment } from "../services/composer-attachments.ts"
import { validComposerMentions, type ComposerMention } from "../services/composer-mentions.ts"
import { githubReferenceLabel } from "../services/github-composer-reference.ts"
import { missingWorker, type LocalWorkspaceStop, type WorkspaceReplyProgress, stoppableSteps } from "../services/workspace-message-timeline.ts"
import {
  applyFeedbackEvent,
  applyFeedbackPush,
  applySnapshotFeedback,
  buildRequestFeedbackMap,
  clearFeedbackState,
  createFeedbackState,
  getLoadedProcess,
  loadedProcessKey,
  mergeLoadedProcess,
  setLoadedProcess,
  type WorkspaceRequestFeedback,
} from "../services/workspace-feedback.ts"
import { useWorkspaceAgentDrafts, type StoredWorkspaceAttachmentDraft } from "../stores/workspace-agent-drafts.ts"

/** The view is keyed by workspace. Late reads must never replace acknowledged mutations. */
export function useWorkspaceConversation(
  api: NonNullable<DeskfleetDesktopApi["superAgent"]>, workspaceId: SuperWorkspaceId,
  followHandoff: (workspaceId: string) => void,
  offline: () => boolean = () => false,
  onSnapshot?: (snapshot: SuperSnapshot) => void,
) {
  const { t } = useI18n()
  function messageOf(reason: unknown): string {
    const message = reason instanceof Error ? reason.message : String(reason)
    return message === archivedTicketError ? t("superAgent.restoreBeforeReply") : message
  }
  const snapshot = shallowRef<SuperSnapshot>()
  const drafts = useWorkspaceAgentDrafts()
  const draft = drafts.get(workspaceId)
  const mentions = computed<ComposerMention[]>({ get: () => draft.mentions ?? [], set: value => { draft.mentions = value } })
  const sentMentions = computed(() => {
    const offset = draft.text.length - draft.text.trimStart().length
    return validComposerMentions(draft.text, mentions.value).map(item => ({ ...item, start: item.start - offset, end: item.end - offset }))
  })
  const commands = useWorkspaceCommands(snapshot, () => draft.replyTo, (kind, name, target) => {
    if (draft.pending?.command && !sameTarget(target, draft.pending.command)) delete draft.pending
    draft.selectedCommand = { kind, name, target, replyTo: draft.replyTo }
  })
  watch([() => superWorkerCommandName(draft.text), mentions, () => draft.replyTo], ([name, items, replyTo]) => {
    const selected = draft.selectedCommand
    if (selected && (selected.replyTo !== replyTo || (selected.kind === "command" ? selected.name !== name
      : !items.some(item => item.reference.kind === "skill" && item.reference.id === selected.name)))) delete draft.selectedCommand
  }, { flush: "sync" })
  const plainOffer = ref<string>()
  const draftKey = computed(() => JSON.stringify([draft.text.trim(), draft.replyTo, draft.reEdit?.sourceMessageId, sentMentions.value]))
  const canSendPlain = computed(() => plainOffer.value === draftKey.value)
  const key = JSON.stringify(workspaceId)
  function attachmentDisplayLabel(item: ComposerAttachment): string | undefined {
    if (item.kind === "github") return githubReferenceLabel(item.item)
    if (item.kind === "pasted_text") return item.label
    if (item.kind === "stored_workspace") {
      return item.attachmentType === "image"
        ? t("agent.image")
        : item.attachmentType === "resource" && item.name === "text/plain"
          ? t("composer.pastedText")
          : item.name
    }
    return item.name
  }
  function extractStoredDrafts(items: readonly ComposerAttachment[]): StoredWorkspaceAttachmentDraft[] | undefined {
    const stored: StoredWorkspaceAttachmentDraft[] = []
    for (const item of items) {
      if (item.kind !== "stored_workspace") continue
      stored.push({
        id: item.id,
        sourceMessageId: item.sourceMessageId,
        index: item.index,
        attachmentType: item.attachmentType,
        name: item.name,
      })
    }
    return stored.length ? stored : undefined
  }
  if (draft.storedAttachments?.length) {
    const existing = drafts.files[key] ?? []
    const existingIds = new Set(existing.map(item => item.id))
    const rehydrated = draft.storedAttachments
      .filter(item => !existingIds.has(item.id))
      .map(item => createStoredWorkspaceAttachment(item.sourceMessageId, item.index, { type: item.attachmentType, name: item.name }, item.id))
    if (rehydrated.length) drafts.files[key] = [...existing, ...rehydrated]
  }
  const missingAttachments = computed(() => (draft.attachmentLabels ?? []).filter(label => !drafts.files[key]?.some(item => item.id === label.id)))
  const attachments = computed<ComposerAttachment[]>({
    get: () => drafts.files[key] ?? [],
    set: items => {
      const missing = missingAttachments.value
      drafts.files[key] = items
      draft.attachmentLabels = [...missing, ...items.map(item => ({ id: item.id, name: attachmentDisplayLabel(item) }))]
      const stored = extractStoredDrafts(items)
      if (stored) draft.storedAttachments = stored
      else delete draft.storedAttachments
    },
  })
  function discardMissing(id: string) {
    draft.attachmentLabels = draft.attachmentLabels?.filter(label => label.id !== id)
  }
  function draftSignature(
    textValue: string,
    replyToValue: string | undefined,
    mentionsList: readonly ComposerMention[],
    items: readonly ComposerAttachment[],
    missingLabels: readonly { id: string; name?: string }[],
  ): string {
    return JSON.stringify([
      textValue,
      replyToValue ?? null,
      mentionsList,
      items.map(item => item.kind === "stored_workspace"
        ? ["stored", item.sourceMessageId, item.index, item.attachmentType, item.name]
        : [item.kind, item.id]),
      missingLabels.map(item => [item.id, item.name ?? null]),
    ])
  }
  const hasExistingDraft = computed(() =>
    Boolean(draft.text.trim())
    || attachments.value.length > 0
    || missingAttachments.value.length > 0
    || Boolean(draft.replyTo)
    || mentions.value.length > 0,
  )
  const reEdit = computed(() => draft.reEdit)
  const hasStashedDraft = computed(() => Boolean(draft.stashedDraft || drafts.stashedFiles[key]?.length))
  const isReEditModified = computed(() => {
    if (!draft.reEdit) return false
    return draftSignature(draft.text, draft.replyTo, mentions.value, attachments.value, missingAttachments.value) !== draft.reEdit.initialSignature
  })
  function stashCurrentDraft(): void {
    const currentFiles = [...(drafts.files[key] ?? [])]
    const currentLabels = draft.attachmentLabels?.map(item => ({ ...item }))
    const currentStored = extractStoredDrafts(currentFiles)
    draft.stashedDraft = {
      text: draft.text,
      ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
      ...(draft.selectedCommand ? { selectedCommand: { ...draft.selectedCommand, target: { ...draft.selectedCommand.target } } } : {}),
      ...(draft.mentions?.length ? { mentions: draft.mentions.map(item => ({ ...item, reference: { ...item.reference } })) } : {}),
      ...(draft.pending ? { pending: structuredClone(draft.pending) } : {}),
      ...(currentLabels?.length ? { attachmentLabels: currentLabels } : {}),
      ...(currentStored?.length ? { storedAttachments: currentStored } : {}),
    }
    if (currentFiles.length) drafts.stashedFiles[key] = currentFiles
    else delete drafts.stashedFiles[key]
  }
  function clearDraftContent(): void {
    draft.text = ""
    delete draft.replyTo
    delete draft.mentions
    delete draft.selectedCommand
    delete draft.pending
    delete draft.attachmentLabels
    delete draft.storedAttachments
    delete drafts.files[key]
  }
  function restoreStashedDraft(): boolean {
    const stashed = draft.stashedDraft
    const stashedAttachmentFiles = drafts.stashedFiles[key]
    delete draft.stashedDraft
    delete drafts.stashedFiles[key]
    if (!stashed && !stashedAttachmentFiles?.length) return false
    draft.text = stashed?.text ?? ""
    if (stashed?.replyTo) draft.replyTo = stashed.replyTo
    else delete draft.replyTo
    if (stashed?.mentions?.length) draft.mentions = stashed.mentions.map(item => ({ ...item, reference: { ...item.reference } }))
    else delete draft.mentions
    if (stashed?.selectedCommand) draft.selectedCommand = { ...stashed.selectedCommand, target: { ...stashed.selectedCommand.target } }
    else delete draft.selectedCommand
    if (stashed?.pending) draft.pending = structuredClone(stashed.pending)
    else delete draft.pending
    const restoredFiles = stashedAttachmentFiles?.length
      ? [...stashedAttachmentFiles]
      : (stashed?.storedAttachments ?? []).map(item =>
          createStoredWorkspaceAttachment(item.sourceMessageId, item.index, { type: item.attachmentType, name: item.name }, item.id))
    if (restoredFiles.length) drafts.files[key] = restoredFiles
    else delete drafts.files[key]
    if (stashed?.attachmentLabels?.length) draft.attachmentLabels = stashed.attachmentLabels.map(item => ({ ...item }))
    else if (restoredFiles.length) draft.attachmentLabels = restoredFiles.map(item => ({ id: item.id, name: attachmentDisplayLabel(item) }))
    else delete draft.attachmentLabels
    const stored = extractStoredDrafts(restoredFiles)
    if (stored?.length) draft.storedAttachments = stored
    else delete draft.storedAttachments
    return true
  }
  function beginReEdit(source: SuperMessage, options?: { stashCurrent?: boolean }): void {
    if (source.role !== "user") return
    if (draft.reEdit?.sourceMessageId === source.id) return
    const preserveExistingStash = Boolean(draft.reEdit && !isReEditModified.value && hasStashedDraft.value)
    if (options?.stashCurrent && !preserveExistingStash && hasExistingDraft.value) {
      stashCurrentDraft()
    }
    const restoredAttachments = (source.attachments ?? []).map((item, index) =>
      createStoredWorkspaceAttachment(source.id, index, item))
    const restoredMentions = source.mentions?.map(item => ({ ...item, reference: { ...item.reference } })) ?? []
    draft.text = source.text
    if (source.replyTo) draft.replyTo = source.replyTo
    else delete draft.replyTo
    if (restoredMentions.length) draft.mentions = restoredMentions
    else delete draft.mentions
    delete draft.selectedCommand
    delete draft.pending
    if (restoredAttachments.length) {
      drafts.files[key] = restoredAttachments
      draft.attachmentLabels = restoredAttachments.map(item => ({ id: item.id, name: attachmentDisplayLabel(item) }))
      draft.storedAttachments = extractStoredDrafts(restoredAttachments)
    } else {
      delete drafts.files[key]
      delete draft.attachmentLabels
      delete draft.storedAttachments
    }
    actionError.value = ""
    draft.reEdit = {
      sourceMessageId: source.id,
      initialSignature: draftSignature(draft.text, draft.replyTo, restoredMentions, restoredAttachments, []),
      ...(hasStashedDraft.value ? { hasStashedDraft: true } : {}),
    }
  }
  function hydrateReEditImagePreview(sourceMessageId: string, index: number, previewDataUrl: string): void {
    const current = drafts.files[key]
    if (!current?.length) return
    let changed = false
    const next = current.map(item => {
      if (item.kind !== "stored_workspace" || item.sourceMessageId !== sourceMessageId || item.index !== index) return item
      if (item.previewDataUrl === previewDataUrl) return item
      changed = true
      return { ...item, previewDataUrl }
    })
    if (changed) drafts.files[key] = next
  }
  function cancelReEdit(mode: "auto" | "restore-stashed" | "keep-as-draft" = "auto"): void {
    if (!draft.reEdit) return
    if (mode === "keep-as-draft") {
      if (draft.pending?.reEditOf) delete draft.pending
      delete draft.reEdit
      delete draft.stashedDraft
      delete drafts.stashedFiles[key]
      return
    }
    if (mode === "restore-stashed") {
      delete draft.reEdit
      if (!restoreStashedDraft()) clearDraftContent()
      return
    }
    if (!isReEditModified.value) {
      delete draft.reEdit
      if (!restoreStashedDraft()) clearDraftContent()
      return
    }
    if (draft.pending?.reEditOf) delete draft.pending
    delete draft.reEdit
  }
  const manuallyFoldedIds = computed(() => new Set(drafts.foldedTurnIds(workspaceId)))
  function foldStoppedTurn(messageId: string): void { drafts.foldTurn(workspaceId, messageId) }
  function unfoldStoppedTurn(messageId: string): void { drafts.unfoldTurn(workspaceId, messageId) }
  const readingError = ref("")
  const actionError = ref("")
  const sending = ref(false)
  const saving = ref(false)
  const localStops = ref(new Map<string, LocalWorkspaceStop>())
  const feedbackState = createFeedbackState(workspaceId)
  const feedbackVersion = ref(0)
  const feedbackConnected = ref(false)
  const visible = useDocumentVisibility()
  let active = true
  let generation = 0
  let reading = false
  let refreshPending = false
  let resyncPending = false
  let bufferedPushes: SuperFeedbackPush[] = []
  let processRequestSeq = 0
  const activeProcessTokens = new Map<string, number>()
  let lastSentId: string | undefined
  let feedbackHandle: SuperFeedbackHandle | undefined
  let feedbackSubscriptionId: string | undefined
  let feedbackEpoch = 0
  let feedbackSubscribing = false
  const error = computed(() => actionError.value || readingError.value)
  function currentRevisions(): Map<string, number> {
    const map = new Map<string, number>()
    for (const message of snapshot.value?.messages ?? []) {
      if (message.role === "user") map.set(message.id, message.revision ?? 0)
    }
    return map
  }
  function requestRefresh() {
    if (!active || offline()) return
    if (reading || saving.value || sending.value) {
      refreshPending = true
      return
    }
    void refresh()
  }
  function flushPendingRefresh() {
    if (!refreshPending || !active || offline() || reading || saving.value || sending.value) return
    refreshPending = false
    void refresh()
  }
  async function closeFeedbackSubscription() {
    feedbackEpoch++
    feedbackSubscribing = false
    feedbackConnected.value = false
    feedbackSubscriptionId = undefined
    resyncPending = false
    bufferedPushes = []
    const handle = feedbackHandle
    feedbackHandle = undefined
    if (handle) await handle.unsubscribe()
  }
  const isHidden = () => visible.value === "hidden"
  async function ensureFeedbackSubscription() {
    const subscribe = api.subscribeFeedback
    if (!active || !subscribe || !snapshot.value?.supportsReplyFeedback || offline() || isHidden()) return
    if (feedbackHandle || feedbackSubscribing) return
    feedbackSubscribing = true
    const epoch = ++feedbackEpoch
    try {
      const handle = await subscribe(
        {
          workspaceId,
          afterCursor: feedbackState.cursor,
          ...(feedbackState.previewGeneration ? { previewGeneration: feedbackState.previewGeneration } : {}),
        },
        push => {
          if (!active || epoch !== feedbackEpoch) return
          if (resyncPending) {
            if (push.workspaceId === workspaceId && feedbackSubscriptionId && push.subscriptionId === feedbackSubscriptionId) {
              bufferedPushes.push(push)
              if (bufferedPushes.length > 256) bufferedPushes.splice(0, bufferedPushes.length - 256)
            }
            return
          }
          const outcome = applyFeedbackPush(feedbackState, push, workspaceId, feedbackSubscriptionId, currentRevisions())
          if (outcome.changed) feedbackVersion.value++
          if (outcome.resyncRequired) {
            resyncPending = true
            bufferedPushes = []
            if (push.workspaceId === workspaceId && feedbackSubscriptionId && push.subscriptionId === feedbackSubscriptionId) {
              bufferedPushes.push(push)
            }
            requestRefresh()
          } else if (outcome.snapshotDirty) {
            requestRefresh()
          }
        },
        () => {
          if (epoch !== feedbackEpoch) return
          feedbackHandle = undefined
          feedbackSubscriptionId = undefined
          feedbackConnected.value = false
          resyncPending = false
          bufferedPushes = []
        },
      )
      if (!active || epoch !== feedbackEpoch || offline() || isHidden() || !snapshot.value?.supportsReplyFeedback) {
        await handle.unsubscribe()
        return
      }
      feedbackHandle = handle
      feedbackSubscriptionId = handle.initial.subscriptionId
      feedbackConnected.value = true
      if (handle.initial.resyncRequired) {
        // Do NOT overwrite previewGeneration before the replacement snapshot arrives:
        // let the next snapshot replace generation, cursor (even if smaller), and old previews atomically.
        resyncPending = true
        bufferedPushes = []
        requestRefresh()
        return
      }
      const revisions = currentRevisions()
      let dirty = false
      let changed = false
      let needsResync = false
      for (const entry of handle.initial.events) {
        if (entry.cursor <= feedbackState.cursor) continue
        feedbackState.cursor = entry.cursor
        const outcome = applyFeedbackEvent(feedbackState, entry.event, entry.cursor, revisions)
        if (outcome.changed) changed = true
        if (outcome.resyncRequired) needsResync = true
        if (outcome.snapshotDirty) dirty = true
      }
      feedbackState.cursor = Math.max(feedbackState.cursor, handle.initial.cursor)
      feedbackState.previewGeneration = handle.initial.previewGeneration
      if (changed) feedbackVersion.value++
      if (needsResync) {
        resyncPending = true
        bufferedPushes = []
        requestRefresh()
      } else if (dirty) {
        requestRefresh()
      }
    } catch {
      if (epoch === feedbackEpoch) feedbackConnected.value = false
    } finally {
      if (epoch === feedbackEpoch) feedbackSubscribing = false
    }
  }
  async function loadProcess(sourceMessageId: string, append = false) {
    const fetchProcess = api.feedbackProcess
    if (!active || !fetchProcess || !snapshot.value?.supportsReplyFeedback || offline()) return
    const revision = currentRevisions().get(sourceMessageId) ?? 0
    const procKey = loadedProcessKey(sourceMessageId, revision)
    const existing = getLoadedProcess(feedbackState, sourceMessageId, revision)
    if (existing?.loading) return
    const token = ++processRequestSeq
    activeProcessTokens.set(procKey, token)
    const isCurrent = () =>
      active
      && snapshot.value?.workspaceId === workspaceId
      && (currentRevisions().get(sourceMessageId) ?? 0) === revision
      && activeProcessTokens.get(procKey) === token
    setLoadedProcess(feedbackState, sourceMessageId, revision, {
      items: existing?.items ?? [],
      hasMore: existing?.hasMore ?? false,
      nextAfterSeq: existing?.nextAfterSeq,
      loading: true,
    })
    feedbackVersion.value++
    try {
      const result = await fetchProcess({
        workspaceId,
        sourceMessageId,
        ...(append && existing?.nextAfterSeq ? { afterSeq: existing.nextAfterSeq } : {}),
      })
      if (!isCurrent() || result.revision !== revision) return
      mergeLoadedProcess(feedbackState, result, append)
      feedbackVersion.value++
    } catch (reason) {
      if (!isCurrent()) return
      const prior = getLoadedProcess(feedbackState, sourceMessageId, revision)
      setLoadedProcess(feedbackState, sourceMessageId, revision, {
        items: prior?.items ?? [],
        hasMore: prior?.hasMore ?? false,
        nextAfterSeq: prior?.nextAfterSeq,
        loading: false,
        error: messageOf(reason),
      })
      feedbackVersion.value++
    } finally {
      if (activeProcessTokens.get(procKey) === token) activeProcessTokens.delete(procKey)
    }
  }
  const feedbackMap = computed<Map<string, WorkspaceRequestFeedback>>(() => {
    void feedbackVersion.value
    const value = snapshot.value
    if (!value?.supportsReplyFeedback) return new Map()
    return buildRequestFeedbackMap(value.messages, feedbackState)
  })
  function accept(value: SuperSnapshot) {
    if (!active || value.workspaceId !== workspaceId) return
    snapshot.value = value
    readingError.value = ""
    const replacing = resyncPending
    applySnapshotFeedback(feedbackState, value, { replace: replacing })
    if (replacing) {
      resyncPending = false
      const queued = bufferedPushes.sort((a, b) => a.cursor - b.cursor)
      bufferedPushes = []
      const revisions = currentRevisions()
      let dirtyAfterReplay = false
      let resyncAfterReplay = false
      for (const push of queued) {
        if (push.previewGeneration !== feedbackState.previewGeneration) continue
        if (push.cursor <= feedbackState.cursor) continue
        const outcome = applyFeedbackPush(feedbackState, push, workspaceId, feedbackSubscriptionId, revisions)
        if (outcome.resyncRequired) {
          resyncAfterReplay = true
          break
        }
        if (outcome.snapshotDirty) dirtyAfterReplay = true
      }
      if (resyncAfterReplay) {
        resyncPending = true
        requestRefresh()
      } else if (dirtyAfterReplay) {
        requestRefresh()
      }
    }
    feedbackVersion.value++
    onSnapshot?.(value)
    if (value.supportsReplyFeedback && api.subscribeFeedback && !offline() && visible.value !== "hidden") {
      void ensureFeedbackSubscription()
    } else if (!value.supportsReplyFeedback && feedbackHandle) {
      void closeFeedbackSubscription()
    }
    for (const [id, local] of localStops.value) {
      if (local.state !== "unconfirmed") continue
      const source = value.messages.find(message => message.id === id)
      const acknowledged = value.messages.some(message => message.sourceMessageId === id && message.stopState && (!local.ticketId || local.ticketId === message.ticketId))
      if ((source?.revision ?? 0) !== local.revision || source?.state === "stopped" || source?.state === "answered" || acknowledged) localStops.value.delete(id)
    }
    const pending = draft.pending
    if (pending && value.messages.some(message => message.id === pending.messageId)) {
      const submitted = pending.attachmentIds ?? []
      const current = draft.attachmentLabels ?? []
      const sameAttachments = current.length === submitted.length && current.every((item, index) => item.id === submitted[index])
      const sameReEdit = draft.reEdit?.sourceMessageId === pending.reEditOf
      if (draft.text.trim() === pending.text && draft.replyTo === pending.replyTo && sameReEdit && sameAttachments && JSON.stringify(sentMentions.value) === JSON.stringify(pending.mentions ?? [])) {
        if (pending.reEditOf) {
          delete draft.reEdit
          if (!restoreStashedDraft()) clearDraftContent()
          actionError.value = ""
        } else {
          draft.text = ""
          delete draft.mentions
          delete draft.selectedCommand
          delete draft.replyTo
          if (submitted.length) {
            const remaining = attachments.value.filter(item => !submitted.includes(item.id))
            drafts.files[key] = remaining
            draft.attachmentLabels = draft.attachmentLabels?.filter(label => !submitted.includes(label.id))
            const stored = extractStoredDrafts(remaining)
            if (stored) draft.storedAttachments = stored
            else delete draft.storedAttachments
          }
          actionError.value = ""
          delete draft.pending
        }
      } else {
        if (submitted.length) {
          const remaining = attachments.value.filter(item => !submitted.includes(item.id))
          drafts.files[key] = remaining
          draft.attachmentLabels = draft.attachmentLabels?.filter(label => !submitted.includes(label.id))
          const stored = extractStoredDrafts(remaining)
          if (stored) draft.storedAttachments = stored
          else delete draft.storedAttachments
        }
        actionError.value = ""
        delete draft.pending
      }
    }
    const transfer = lastSentId && value.messages.find(message => message.id === lastSentId)
    if (transfer && transfer.state === "transferred" && transfer.targetWorkspaceId && visible.value !== "hidden") {
      lastSentId = undefined
      followHandoff(transfer.targetWorkspaceId)
    }
  }
  async function refresh() {
    if (!active || offline()) return
    if (reading || saving.value || sending.value) {
      refreshPending = true
      return
    }
    refreshPending = false
    const issued = generation
    reading = true
    try {
      const value = await api.snapshot({ workspaceId })
      if (active && generation === issued) accept(value)
    } catch (reason) {
      if (active && generation === issued) readingError.value = messageOf(reason)
    } finally {
      reading = false
      flushPendingRefresh()
    }
  }
  let pollTicks = 0
  const polling = useIntervalFn(() => {
    pollTicks++
    // When subscribed to real-time feedback, keep a lightweight periodic reconciliation rather than 2s full polls.
    if (feedbackConnected.value && pollTicks % 7 !== 0) return
    void refresh()
  }, 2000, { immediate: false })
  watch([visible, offline], ([current, disconnected]) => {
    if (disconnected || current === "hidden") {
      refreshPending = false
      polling.pause()
      void closeFeedbackSubscription()
    } else {
      polling.resume()
      void refresh()
    }
  }, { immediate: true })
  onScopeDispose(() => {
    active = false
    refreshPending = false
    resyncPending = false
    bufferedPushes = []
    activeProcessTokens.clear()
    clearFeedbackState(feedbackState)
    void closeFeedbackSubscription()
  })
  function canRoute(text: string, hasAttachments: boolean, needsCoordinator = true): boolean {
    try {
      const style = needsCoordinator && snapshot.value?.supportsAdhdSkill ? adhdCommand(text) : undefined
      if (style) {
        text = style.task
        if (!text && !hasAttachments) return true
      }
      const reference = parseWorkerReference(text)
      const state = snapshot.value
      if (reference) {
        if (!state?.supportsWorkerReferences) actionError.value = t("superAgent.workerReferenceUnsupported")
        else if (!reference.text && !hasAttachments) actionError.value = t("superAgent.workerReferenceNeedsTask")
        else return true
      } else if (needsCoordinator && state?.coordinatorProviders && !state.coordinatorProviders.some(provider => provider.id === state.coordinator)) {
        actionError.value = t(state.coordinatorProviders.length ? "superAgent.chooseCoordinatorBeforeSending" : "superAgent.addCoordinatorBeforeSending")
      } else return true
    } catch {
      actionError.value = t("superAgent.invalidWorkerReference")
    }
    return false
  }
  async function send(asPlain = false) {
    const text = draft.text.trim()
    const replyTo = draft.replyTo
    const reEditOf = draft.reEdit?.sourceMessageId
    const items = attachments.value
    const reused = workspaceReusedAttachments(items)
    const newBlocks = workspacePromptAttachments(items)
    const references = sentMentions.value
    if (offline() || (!text && !items.length) || sending.value || saving.value || !snapshot.value || missingAttachments.value.length) return
    if (items.length && !snapshot.value.supportsAttachments) return
    if (asPlain && !canSendPlain.value) return
    const ids = items.map(item => item.id)
    const pending = draft.pending
    const matches = pending?.text === text && pending.replyTo === replyTo && pending.reEditOf === reEditOf
      && JSON.stringify(pending.reusedAttachments ?? []) === JSON.stringify(reused)
      && JSON.stringify(pending.mentions ?? []) === JSON.stringify(references)
      && (pending.attachmentIds?.length ?? 0) === ids.length && ids.every((id, i) => id === pending.attachmentIds?.[i])
    plainOffer.value = undefined
    sending.value = true
    generation++
    actionError.value = ""
    try {
      const skills = references.flatMap(item => item.reference.kind === "skill" ? [item.reference] : [])
      const builtIn = !skills.length && snapshot.value?.supportsAdhdSkill && adhdCommand(text)
      const name = builtIn ? undefined : superWorkerCommandName(text)
      if (references.length && !snapshot.value?.supportsComposerMentions) throw new Error(t("superAgent.commands.updateHost"))
      let command: SuperWorkerCommandTarget | undefined
      if (matches) command = pending.command
      else if (!asPlain && (name || skills.length)) {
        const selected = draft.selectedCommand
        const key = draftKey.value
        if (!snapshot.value?.supportsWorkerCommands && !skills.length) plainOffer.value = key
        await commands.discover()
        if (!active || key !== draftKey.value || offline()) return
        command = commands.owner(name, skills)
        if (!command) {
          if (!skills.length) plainOffer.value = key
          throw new Error(t("superAgent.commands.unknown", { command: `/${name}` }))
        }
        if (selected && !sameTarget(command, selected.target)) {
          throw new Error(t("superAgent.commands.targetChanged"))
        }
      }
      if (!canRoute(text, items.length > 0, !command)) return
      const clientTimeZone = snapshot.value?.supportsScheduleCommands
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
        : undefined
      const request = {
        workspaceId,
        messageId: matches ? pending.messageId : crypto.randomUUID(),
        text,
        ...(replyTo && { replyTo }),
        ...(reEditOf && { reEditOf }),
        ...(reused.length && { reusedAttachments: reused }),
        ...(command && { command }),
        ...(references.length && { mentions: references }),
        ...(clientTimeZone && { timeZone: clientTimeZone }),
      }
      draft.pending = { ...request, ...(ids.length ? { attachmentIds: ids } : {}) }
      lastSentId = request.messageId
      accept(await api.send({ ...request, ...(newBlocks.length ? { attachments: newBlocks } : {}) }))
    }
    catch (reason) { if (active) actionError.value = messageOf(reason) }
    finally {
      sending.value = false
      flushPendingRefresh()
    }
  }
  async function change(operation: () => Promise<SuperSnapshot>, reportError: boolean | "dialog" = true) {
    if (offline() || saving.value || sending.value) {
      if (reportError === "dialog") throw new Error(t("superAgent.archiveUnavailable"))
      return false
    }
    saving.value = true
    generation++
    actionError.value = ""
    try { accept(await operation()); return true }
    catch (reason) {
      if (reportError === "dialog") throw reason
      if (active && reportError) actionError.value = messageOf(reason)
      return false
    }
    finally {
      saving.value = false
      flushPendingRefresh()
    }
  }
  async function stop(progress: WorkspaceReplyProgress, ticketId?: string) {
    const command = api.stop
    if (!command || offline() || saving.value || sending.value || !snapshot.value?.supportsStop) return
    const steps = stoppableSteps(progress).filter(step => !ticketId || step.ticketId === ticketId)
    if (!steps.length) return
    if (steps.length === 1) ticketId = steps[0]!.ticketId
    const { sourceId: messageId, revision } = progress
    const sharedTurns = steps.flatMap(step => step.sharedTurn && step.ticketId && step.turnId ? [{ ticketId: step.ticketId, turnId: step.turnId }] : [])
    localStops.value.set(messageId, { ticketId, revision, state: "stopping" })
    const ok = await change(() => command({ workspaceId, messageId, revision, ...(ticketId && { ticketId }),
      ...(sharedTurns.length && { sharedTurns }) }), false)
    if (ok) localStops.value.delete(messageId)
    else localStops.value.set(messageId, { ticketId, revision, state: "unconfirmed" })
  }
  return {
    stop, localStops, feedbackMap, feedbackConnected, loadProcess,
    hasExistingDraft, reEdit, hasStashedDraft, isReEditModified, beginReEdit, hydrateReEditImagePreview, cancelReEdit,
    manuallyFoldedIds, foldStoppedTurn, unfoldStoppedTurn,
    archiveTicket: async (ticketId: string, sessionId: string | null, archived: boolean, operationId: string) => {
      const archive = api.archiveTicket
      if (!archive || !snapshot.value?.supportsTicketArchive) throw new Error(t("superAgent.archiveUnavailable"))
      await change(() => archive({ workspaceId, ticketId, sessionId, archived, operationId }), "dialog")
    },
    snapshot, draft, attachments, mentions, missingAttachments, discardMissing, error, sending, saving, send, refresh, commandMenu: commands.menu, canSendPlain, canRefresh: computed(() => !!readingError.value && !actionError.value),
    retry: (message: SuperMessage) => canRoute(message.text, !!message.attachments?.length, !message.command && !missingWorker(message)) && change(() => {
      lastSentId = message.id
      return api.send({ workspaceId, messageId: message.id, text: message.text, replyTo: message.replyTo, ...(message.command && { command: message.command }), ...(message.mentions?.length && { mentions: message.mentions }), retry: true })
    }),
    correct: (messageId: string, ticketId: string) => change(() => api.correct({ workspaceId, messageId, ticketId })),
    linkMessage: (messageId: string, ticketIds: string[]) => api.linkMessage ? change(() => api.linkMessage!({ workspaceId, messageId, ticketIds })) : Promise.resolve(false),
    createTicket: (messageId: string, title: string, scope?: string) => api.createTicket ? change(() => api.createTicket!({ workspaceId, messageId, title, ...(scope ? { scope } : {}) })) : Promise.resolve(false),
    saveSettings: (settings: Omit<SuperSettings, "workspaceId">) => change(() => api.settings({ ...settings, workspaceId })),
  }
}
function sameTarget(a: SuperWorkerCommandTarget, b: SuperWorkerCommandTarget): boolean {
  return a.provider === b.provider && a.ticketId === b.ticketId && a.sessionId === b.sessionId
}
