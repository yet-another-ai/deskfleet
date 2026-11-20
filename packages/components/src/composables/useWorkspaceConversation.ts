import { useDocumentVisibility, useIntervalFn } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { parseWorkerReference } from "@deskfleet/client/worker-reference"
import { superWorkerCommandName, type SuperMessage, type SuperSettings, type SuperSnapshot, type SuperWorkerCommandTarget, type SuperWorkspaceId } from "../../../../apps/daemon/src/super-agent-protocol.ts"
import { useWorkspaceCommands } from "./useWorkspaceCommands.ts"
import { workspacePromptAttachments, type ComposerAttachment } from "../services/composer-attachments.ts"
import { validComposerMentions, type ComposerMention } from "../services/composer-mentions.ts"
import { githubReferenceLabel } from "../services/github-composer-reference.ts"
import { missingWorker } from "../services/workspace-message-timeline.ts"
import { useWorkspaceAgentDrafts } from "../stores/workspace-agent-drafts.ts"

/** The view is keyed by workspace. Late reads must never replace acknowledged mutations. */
export function useWorkspaceConversation(
  api: NonNullable<DeskfleetDesktopApi["superAgent"]>, workspaceId: SuperWorkspaceId,
  followHandoff: (workspaceId: string) => void,
  offline: () => boolean = () => false,
) {
  const { t } = useI18n()
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
  const draftKey = computed(() => JSON.stringify([draft.text.trim(), draft.replyTo, sentMentions.value]))
  const canSendPlain = computed(() => plainOffer.value === draftKey.value)
  const key = JSON.stringify(workspaceId)
  const missingAttachments = computed(() => (draft.attachmentLabels ?? []).filter(label => !drafts.files[key]?.some(item => item.id === label.id)))
  const attachments = computed<ComposerAttachment[]>({
    get: () => drafts.files[key] ?? [],
    set: items => {
      const missing = missingAttachments.value
      drafts.files[key] = items
      draft.attachmentLabels = [...missing, ...items.map(item => ({ id: item.id, name: item.kind === "github" ? githubReferenceLabel(item.item) : item.kind === "pasted_text" ? item.label : item.name }))]
    },
  })
  function discardMissing(id: string) {
    draft.attachmentLabels = draft.attachmentLabels?.filter(label => label.id !== id)
  }
  const readingError = ref("")
  const actionError = ref("")
  const sending = ref(false)
  const saving = ref(false)
  const visible = useDocumentVisibility()
  let active = true
  let generation = 0
  let reading = false
  let lastSentId: string | undefined
  const error = computed(() => actionError.value || readingError.value)
  function accept(value: SuperSnapshot) {
    if (!active || value.workspaceId !== workspaceId) return
    snapshot.value = value
    readingError.value = ""
    const pending = draft.pending
    if (pending && value.messages.some(message => message.id === pending.messageId)) {
      const submitted = pending.attachmentIds ?? []
      const current = draft.attachmentLabels ?? []
      const sameAttachments = current.length === submitted.length && current.every((item, index) => item.id === submitted[index])
      if (draft.text.trim() === pending.text && draft.replyTo === pending.replyTo && sameAttachments && JSON.stringify(sentMentions.value) === JSON.stringify(pending.mentions ?? [])) {
        draft.text = ""
        delete draft.mentions
        delete draft.selectedCommand
        delete draft.replyTo
      }
      if (submitted.length) {
        drafts.files[key] = attachments.value.filter(item => !submitted.includes(item.id))
        draft.attachmentLabels = draft.attachmentLabels?.filter(label => !submitted.includes(label.id))
      }
      actionError.value = ""
      delete draft.pending
    }
    const transfer = lastSentId && value.messages.find(message => message.id === lastSentId)
    if (transfer && transfer.state === "transferred" && transfer.targetWorkspaceId && visible.value !== "hidden") {
      lastSentId = undefined
      followHandoff(transfer.targetWorkspaceId)
    }
  }
  async function refresh() {
    if (offline() || reading || saving.value || sending.value) return
    const issued = generation
    reading = true
    try {
      const value = await api.snapshot({ workspaceId })
      if (active && generation === issued) accept(value)
    } catch (reason) {
      if (active && generation === issued) readingError.value = messageOf(reason)
    } finally { reading = false }
  }
  const polling = useIntervalFn(() => { void refresh() }, 2000, { immediate: false })
  watch([visible, offline], ([current, disconnected]) => {
    if (disconnected || current === "hidden") polling.pause()
    else { polling.resume(); void refresh() }
  }, { immediate: true })
  onScopeDispose(() => { active = false })
  function canRoute(text: string, hasAttachments: boolean, needsCoordinator = true): boolean {
    try {
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
    const items = attachments.value
    const references = sentMentions.value
    if (offline() || (!text && !items.length) || sending.value || saving.value || !snapshot.value || missingAttachments.value.length) return
    if (items.length && !snapshot.value.supportsAttachments) return
    if (asPlain && !canSendPlain.value) return
    const ids = items.map(item => item.id)
    const pending = draft.pending
    const matches = pending?.text === text && pending.replyTo === replyTo && JSON.stringify(pending.mentions ?? []) === JSON.stringify(references)
      && (pending.attachmentIds?.length ?? 0) === ids.length && ids.every((id, i) => id === pending.attachmentIds?.[i])
    plainOffer.value = undefined
    sending.value = true
    generation++
    actionError.value = ""
    try {
      const name = superWorkerCommandName(text)
      const skills = references.flatMap(item => item.reference.kind === "skill" ? [item.reference] : [])
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
      const request = { workspaceId, messageId: matches ? pending.messageId : crypto.randomUUID(), text, ...(replyTo && { replyTo }),
        ...(command && { command }), ...(references.length && { mentions: references }) }
      draft.pending = { ...request, ...(ids.length ? { attachmentIds: ids } : {}) }
      lastSentId = request.messageId
      accept(await api.send({ ...request, ...(items.length ? { attachments: workspacePromptAttachments(items) } : {}) }))
    }
    catch (reason) { if (active) actionError.value = messageOf(reason) }
    finally { sending.value = false }
  }
  async function change(operation: () => Promise<SuperSnapshot>) {
    if (offline() || saving.value || sending.value) return false
    saving.value = true
    generation++
    actionError.value = ""
    try { accept(await operation()); return true }
    catch (reason) { if (active) actionError.value = messageOf(reason); return false }
    finally { saving.value = false }
  }
  return {
    snapshot, draft, attachments, mentions, missingAttachments, discardMissing, error, sending, saving, send, refresh, commandMenu: commands.menu, canSendPlain, canRefresh: computed(() => !!readingError.value && !actionError.value),
    retry: (message: SuperMessage) => canRoute(message.text, !!message.attachments?.length, !message.command && !missingWorker(message)) && change(() => {
      lastSentId = message.id
      return api.send({ workspaceId, messageId: message.id, text: message.text, replyTo: message.replyTo, ...(message.command && { command: message.command }), ...(message.mentions?.length && { mentions: message.mentions }), retry: true })
    }),
    correct: (messageId: string, ticketId: string) => change(() => api.correct({ workspaceId, messageId, ticketId })),
    saveSettings: (settings: Omit<SuperSettings, "workspaceId">) => change(() => api.settings({ ...settings, workspaceId })),
  }
}
function sameTarget(a: SuperWorkerCommandTarget, b: SuperWorkerCommandTarget): boolean {
  return a.provider === b.provider && a.ticketId === b.ticketId && a.sessionId === b.sessionId
}
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
