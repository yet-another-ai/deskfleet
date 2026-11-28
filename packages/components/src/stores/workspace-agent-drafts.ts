import { defineStore } from "pinia"
import { useSessionStorage } from "@vueuse/core"
import { ref } from "vue"
import { useAccountSession } from "../composables/account-session-context.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import type { ComposerAttachment } from "../services/composer-attachments.ts"
import type { ComposerMention } from "../services/composer-mentions.ts"
import type { SuperAttachmentInfo, SuperSend, SuperWorkerCommandTarget, SuperWorkspaceId } from "@deskfleet/protocol/super-agent"

export interface StoredWorkspaceAttachmentDraft {
  id: string
  sourceMessageId: string
  index: number
  attachmentType: SuperAttachmentInfo["type"]
  name: string
}

export interface StashedWorkspaceDraft {
  text: string
  replyTo?: string
  selectedCommand?: { kind: "command" | "skill"; name: string; replyTo?: string; target: SuperWorkerCommandTarget }
  mentions?: ComposerMention[]
  pending?: Omit<SuperSend, "attachments"> & { attachmentIds?: string[] }
  attachmentLabels?: { id: string; name?: string }[]
  storedAttachments?: StoredWorkspaceAttachmentDraft[]
}

export interface ReEditDraftState {
  sourceMessageId: string
  initialSignature: string
  hasStashedDraft?: boolean
}

export interface WorkspaceAgentDraft {
  text: string
  replyTo?: string
  selectedCommand?: { kind: "command" | "skill"; name: string; replyTo?: string; target: SuperWorkerCommandTarget }
  mentions?: ComposerMention[]
  /** Retain the original id until the daemon acknowledges the submitted content. */
  pending?: Omit<SuperSend, "attachments"> & { attachmentIds?: string[] }
  attachmentLabels?: { id: string; name?: string }[]
  /** Small metadata references for attachments restored from an earlier SA message. */
  storedAttachments?: StoredWorkspaceAttachmentDraft[]
  /** Explicit re-edit state when revising a confirmed-stopped SA turn. */
  reEdit?: ReEditDraftState
  /** Previous non-empty draft stashed while re-editing so abandoning or sending never drops it. */
  stashedDraft?: StashedWorkspaceDraft
}

/** Machine-scoped Pinia keeps each workspace draft while navigating to a Worker. */
export const useWorkspaceAgentDrafts = defineStore("workspace-agent-drafts", () => {
  const account = useAccountSession()
  const machineId = usePlatformClient().target?.id
  const user = account?.account.value.user
  const scope = user && machineId && account?.teamId.value
    ? JSON.stringify([account.account.value.serverUrl, user.id, account.teamId.value, machineId]) : undefined
  // Each Electron window retains its own request IDs through a renderer reload.
  const drafts = scope ? useSessionStorage<Record<string, WorkspaceAgentDraft>>(`deskfleet.workspace-agent.drafts:${scope}`, {}, { writeDefaults: false })
    : ref<Record<string, WorkspaceAgentDraft>>({})
  // Display-only manual fold preferences for stopped turns (never creates replacement semantics).
  const manuallyFolded = scope ? useSessionStorage<Record<string, string[]>>(`deskfleet.workspace-agent.folded-turns:${scope}`, {}, { writeDefaults: false })
    : ref<Record<string, string[]>>({})
  // Files and image bytes live in the window, never in quota-limited sessionStorage.
  const files = ref<Record<string, ComposerAttachment[]>>({})
  // Stashed in-memory attachments belonging to a draft temporarily set aside during re-edit.
  const stashedFiles = ref<Record<string, ComposerAttachment[]>>({})
  function get(workspaceId: SuperWorkspaceId): WorkspaceAgentDraft {
    const key = JSON.stringify(workspaceId)
    drafts.value[key] ??= { text: "" }
    return drafts.value[key]!
  }
  function foldedTurnIds(workspaceId: SuperWorkspaceId): readonly string[] {
    return manuallyFolded.value[JSON.stringify(workspaceId)] ?? []
  }
  function foldTurn(workspaceId: SuperWorkspaceId, messageId: string): void {
    const key = JSON.stringify(workspaceId)
    const current = manuallyFolded.value[key] ?? []
    if (current.includes(messageId)) return
    manuallyFolded.value = { ...manuallyFolded.value, [key]: [...current, messageId] }
  }
  function unfoldTurn(workspaceId: SuperWorkspaceId, messageId: string): void {
    const key = JSON.stringify(workspaceId)
    const current = manuallyFolded.value[key] ?? []
    if (!current.includes(messageId)) return
    const next = current.filter(id => id !== messageId)
    const updated = { ...manuallyFolded.value }
    if (next.length) updated[key] = next
    else delete updated[key]
    manuallyFolded.value = updated
  }
  return { get, files, stashedFiles, foldedTurnIds, foldTurn, unfoldTurn }
})
