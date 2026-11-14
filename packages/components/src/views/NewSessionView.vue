<script setup lang="ts">
import { vNavigationMotion } from "../directives/navigation-motion.ts"
import { useNavigationMotion } from "../composables/useNavigationMotion.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { storeToRefs } from "pinia"
import { computed, onScopeDispose, ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ErrorNotice from "../components/common/ErrorNotice.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useFileTarget } from "../composables/useFileTarget.ts"
import { hasIncompleteAttachmentUploads, hasSubmittableText, previewPromptContent, sessionTitleFromDraft } from "../services/composer-attachments.ts"
import { buildComposerPrompt } from "../services/composer-prompt.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useLayoutStore } from "../stores/layout.ts"
import { useProvidersStore } from "../stores/providers.ts"
import type { AgentActor } from "../../../../apps/daemon/src/agent-protocol.ts"
import type { GitPreparationSnapshot } from "../../../../apps/daemon/src/git-protocol.ts"

const client = usePlatformClient()
const account = useAccountSession()
const { t } = useI18n()
const motion = useNavigationMotion()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
const router = useRouter()
let disposed = false
onScopeDispose(() => { disposed = true })
const { sessionContext } = storeToRefs(useLayoutStore())
const { newSessionTarget } = storeToRefs(fleet)
const resourceTarget = useFileTarget(() => newSessionTarget.value?.machine.id)
const draftKey = computed(() => {
  const target = newSessionTarget.value
  if (!target) return "draft"
  return target.workspace ? `workspace:${target.workspace.id}` : `machine:${target.machine.id}`
})
const draft = computed({ get: () => agents.drafts[draftKey.value] ?? "", set: value => { agents.drafts[draftKey.value] = value } })
const attachments = computed({ get: () => agents.draftAttachments[draftKey.value] ?? [], set: value => { agents.draftAttachments[draftKey.value] = value } })
const mentions = computed({ get: () => agents.draftMentions[draftKey.value] ?? [], set: value => { agents.draftMentions[draftKey.value] = value } })
const baseBranch = ref<string>()
const baseRevisions = ref<GitPreparationSnapshot["baseRevisions"]>()
const workingDirectory = ref<string>()
const submitting = ref(false)
const error = shallowRef<unknown>()
async function submit(): Promise<void> {
  const target = newSessionTarget.value
  const text = draft.value
  const currentAttachments = attachments.value
  const currentMentions = mentions.value
  const submittedDraft = { mentions: currentMentions, attachmentIds: currentAttachments.map(item => item.id) }
  const fileTarget = resourceTarget.value
  const key = draftKey.value
  if (!target || submitting.value || !hasSubmittableText(text, currentAttachments) || hasIncompleteAttachmentUploads(currentAttachments, fileTarget) || !providers.ready || !providers.selectedId) return
  const context = target.workspace ? sessionContext.value : "directory"
  submitting.value = true
  error.value = null
  let preparingSessionId: string | undefined
  try {
    const cwd = context === "directory" ? workingDirectory.value : undefined
    const snapshot = await agents.create(target.workspace?.id, sessionTitleFromDraft(text, currentAttachments), context, providers.selectedId,
      context === "worktree" && !baseRevisions.value ? baseBranch.value : undefined, context === "worktree" ? baseRevisions.value : undefined,
      undefined, { deferStartup: true, ...(cwd ? { cwd } : {}) })
    const id = snapshot.session.id
    preparingSessionId = id
    agents.preparingDrafts[id] = true
    const canStartPrompt = snapshot.session.lifecycle === "ready" || snapshot.session.lifecycle === "provisioning"
    if (canStartPrompt) {
      const userId = account?.account.value.user?.id
      const author: AgentActor = userId
        ? { kind: "user", userId, sourceMachine: { originId: "", id: target.machine.id } }
        : { kind: "local_token", sourceMachine: { originId: "", id: target.machine.id } }
      agents.optimisticInputs[id] = {
        id: "optimistic",
        sessionId: id,
        submissionCommandId: "",
        author,
        content: previewPromptContent(text, currentAttachments),
        acceptedSeq: "0",
        state: "pending",
        requestedDelivery: "backlog",
        createdAt: new Date().toISOString(),
      }
    } else {
      agents.drafts[id] = text
      agents.draftAttachments[id] = currentAttachments
      agents.draftMentions[id] = currentMentions
    }
    if (agents.drafts[key] === text && JSON.stringify(agents.draftMentions[key] ?? []) === JSON.stringify(currentMentions)) agents.drafts[key] = ""
    if (agents.draftAttachments[key] === currentAttachments) agents.draftAttachments[key] = []
    if (agents.draftMentions[key] === currentMentions) agents.draftMentions[key] = []
    void fleet.refreshLocalCatalog().catch(() => undefined)
    const sameTarget = newSessionTarget.value?.workspace?.id === target.workspace?.id
      && newSessionTarget.value?.machine.id === target.machine.id
    if (!disposed && router.currentRoute.value.name === "new-session" && sameTarget) await router.push({ name: "session", params: { sessionId: id } })
    // A rejected or disconnected submission remains in the Session draft for reconciliation.
    if (canStartPrompt) {
      await (async () => {
        const content = currentAttachments.length || currentMentions.length
          ? await buildComposerPrompt({ draft: text, attachments: currentAttachments, mentions: currentMentions, providerId: snapshot.session.provider,
            sessionId: id, target: fileTarget, filesApi: client.files, resolveReferences: agents.resolveComposerReferences })
          : text
        await agents.submit(id, content, "backlog", undefined, text, submittedDraft)
      })().catch(reason => {
        delete agents.optimisticInputs[id]
        if (!agents.drafts[id]) agents.drafts[id] = text
        if (!agents.draftAttachments[id]?.length && currentAttachments.length) agents.draftAttachments[id] = currentAttachments
        if (!agents.draftMentions[id]?.length && currentMentions.length) agents.draftMentions[id] = currentMentions
        agents.draftErrors[id] = reason instanceof Error ? reason.message : String(reason)
      })
    }
  } catch (reason) { error.value = reason }
  finally {
    if (preparingSessionId) delete agents.preparingDrafts[preparingSessionId]
    submitting.value = false
  }
}
</script>

<template>
  <PaneHeader />
  <div v-navigation-motion="motion" class="relative isolate flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
    <div class="ui-aurora" aria-hidden="true" />
    <h1 class="ui-gradient-text m-0 pb-1 text-center text-3xl font-semibold tracking-tight">{{ t("newSession.heading") }}</h1>
    <p v-if="!newSessionTarget" class="m-0 text-ui-text-muted">{{ t("newSession.noTarget") }}</p>
    <p v-if="submitting" role="status" class="text-sm text-ui-text-muted">{{ t("agent.creating") }}</p>
    <ErrorNotice v-if="error" :error="error" class="w-full max-w-xl" />
    <ErrorNotice v-if="newSessionTarget?.machine.online && providers.error" :error="providers.error" class="w-full max-w-xl" />
    <p v-else-if="newSessionTarget?.machine.online && providers.ready && !providers.providers.length" class="max-w-xl text-center text-sm text-ui-text-muted">{{ t('providers.noneConfigured') }} <RouterLink :to="{ name: 'settings-agents' }" class="text-ui-accent hover:underline">{{ t('providers.manage') }}</RouterLink></p>
  </div>
  <SessionComposer v-model="draft" v-model:attachments="attachments" v-model:mentions="mentions" v-model:context="sessionContext" v-model:base-branch="baseBranch" v-model:base-revisions="baseRevisions" v-model:cwd="workingDirectory" :location="newSessionTarget" :disabled="!newSessionTarget?.machine.online || !providers.ready || !providers.selectedId" :submitting="submitting" show-target @submit="submit" />
</template>
