<script setup lang="ts">
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { storeToRefs } from "pinia"
import { computed, onScopeDispose, ref } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import { useFileTarget } from "../composables/useFileTarget.ts"
import { hasSubmittableText, sessionTitleFromDraft } from "../services/composer-attachments.ts"
import { buildComposerPrompt } from "../services/composer-prompt.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useLayoutStore } from "../stores/layout.ts"
import { useProvidersStore } from "../stores/providers.ts"

const client = usePlatformClient()
const { t } = useI18n()
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
const submitting = ref(false)
const error = ref<string | null>(null)
async function submit(): Promise<void> {
  const target = newSessionTarget.value
  const text = draft.value
  const currentAttachments = attachments.value
  const currentMentions = mentions.value
  const submittedDraft = { mentions: currentMentions, attachmentIds: currentAttachments.map(item => item.id) }
  const fileTarget = resourceTarget.value
  const key = draftKey.value
  if (!target || submitting.value || !hasSubmittableText(text, currentAttachments) || !providers.ready || !providers.selectedId) return
  const context = target.workspace ? sessionContext.value : "directory"
  submitting.value = true
  error.value = null
  let preparingSessionId: string | undefined
  try {
    const snapshot = await agents.create(target.workspace?.id, sessionTitleFromDraft(text, currentAttachments), context, providers.selectedId, context === "worktree" ? baseBranch.value : undefined)
    const id = snapshot.session.id
    preparingSessionId = id
    agents.preparingDrafts[id] = true
    agents.drafts[id] = text
    agents.draftAttachments[id] = currentAttachments
    agents.draftMentions[id] = currentMentions
    if (agents.drafts[key] === text && JSON.stringify(agents.draftMentions[key] ?? []) === JSON.stringify(currentMentions)) agents.drafts[key] = ""
    if (agents.draftAttachments[key] === currentAttachments) agents.draftAttachments[key] = []
    if (agents.draftMentions[key] === currentMentions) agents.draftMentions[key] = []
    await fleet.refreshLocalCatalog()
    const sameTarget = newSessionTarget.value?.workspace?.id === target.workspace?.id
      && newSessionTarget.value?.machine.id === target.machine.id
    if (!disposed && router.currentRoute.value.name === "new-session" && sameTarget) await router.push({ name: "session", params: { sessionId: id } })
    // A rejected or disconnected submission remains in the Session draft for reconciliation.
    if (snapshot.session.lifecycle === "ready") {
      await (async () => {
        const content = currentAttachments.length || currentMentions.length
          ? await buildComposerPrompt({ draft: text, attachments: currentAttachments, mentions: currentMentions, providerId: snapshot.session.provider,
            sessionId: id, target: fileTarget, filesApi: client.files, resolveReferences: agents.resolveComposerReferences })
          : text
        await agents.submit(id, content, "backlog", undefined, text, submittedDraft)
      })().catch(reason => {
        agents.draftErrors[id] = reason instanceof Error ? reason.message : String(reason)
      })
    }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally {
    if (preparingSessionId) delete agents.preparingDrafts[preparingSessionId]
    submitting.value = false
  }
}
</script>

<template>
  <PaneHeader />
  <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
    <h1 class="m-0 text-center text-3xl font-semibold">{{ t("newSession.heading") }}</h1>
    <p v-if="!newSessionTarget" class="m-0 text-ui-text-muted">{{ t("newSession.noTarget") }}</p>
    <p v-if="submitting" role="status" class="text-sm text-ui-text-muted">{{ t("agent.creating") }}</p>
    <p v-if="error" role="alert" class="max-w-xl text-sm text-ui-danger">{{ error }}</p>
    <p v-if="newSessionTarget?.machine.online && providers.error" role="alert" class="max-w-xl text-sm text-ui-danger">{{ providers.error }}</p>
    <p v-else-if="newSessionTarget?.machine.online && providers.ready && !providers.providers.length" class="max-w-xl text-center text-sm text-ui-text-muted">{{ t('providers.noneConfigured') }} <RouterLink :to="{ name: 'settings-agents' }" class="text-ui-accent hover:underline">{{ t('providers.manage') }}</RouterLink></p>
  </div>
  <SessionComposer v-model="draft" v-model:attachments="attachments" v-model:mentions="mentions" v-model:context="sessionContext" v-model:base-branch="baseBranch" :location="newSessionTarget" :disabled="!newSessionTarget?.machine.online || !providers.ready || !providers.selectedId" :submitting="submitting" show-target @submit="submit" />
</template>
