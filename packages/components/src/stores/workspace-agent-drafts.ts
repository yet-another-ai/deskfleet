import { defineStore } from "pinia"
import { useSessionStorage } from "@vueuse/core"
import { ref } from "vue"
import { useAccountSession } from "../composables/account-session-context.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import type { ComposerAttachment } from "../services/composer-attachments.ts"
import type { ComposerMention } from "../services/composer-mentions.ts"
import type { SuperSend, SuperWorkerCommandTarget, SuperWorkspaceId } from "../../../../apps/daemon/src/super-agent-protocol.ts"

interface Draft {
  text: string
  replyTo?: string
  selectedCommand?: { kind: "command" | "skill"; name: string; replyTo?: string; target: SuperWorkerCommandTarget }
  mentions?: ComposerMention[]
  /** Retain the original id until the daemon acknowledges the submitted content. */
  pending?: Omit<SuperSend, "attachments"> & { attachmentIds?: string[] }
  attachmentLabels?: { id: string; name?: string }[]
}

/** Machine-scoped Pinia keeps each workspace draft while navigating to a Worker. */
export const useWorkspaceAgentDrafts = defineStore("workspace-agent-drafts", () => {
  const account = useAccountSession()
  const machineId = usePlatformClient().target?.id
  const user = account?.account.value.user
  const scope = user && machineId && account?.teamId.value
    ? JSON.stringify([account.account.value.serverUrl, user.id, account.teamId.value, machineId]) : undefined
  // Each Electron window retains its own request IDs through a renderer reload.
  const drafts = scope ? useSessionStorage<Record<string, Draft>>(`deskfleet.workspace-agent.drafts:${scope}`, {}, { writeDefaults: false })
    : ref<Record<string, Draft>>({})
  // Files and image bytes live in the window, never in quota-limited sessionStorage.
  const files = ref<Record<string, ComposerAttachment[]>>({})
  function get(workspaceId: SuperWorkspaceId): Draft {
    const key = JSON.stringify(workspaceId)
    drafts.value[key] ??= { text: "" }
    return drafts.value[key]!
  }
  return { get, files }
})
