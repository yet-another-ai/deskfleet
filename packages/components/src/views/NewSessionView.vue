<script setup lang="ts">
import { storeToRefs } from "pinia"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import { useFleetStore } from "../stores/fleet.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useLayoutStore } from "../stores/layout.ts"
import { useProvidersStore } from "../stores/providers.ts"
const { t } = useI18n()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
const router = useRouter()
const { sessionContext } = storeToRefs(useLayoutStore())
const { newSessionTarget } = storeToRefs(fleet)
const draftKey = computed(() => {
  const target = newSessionTarget.value
  if (!target) return "draft"
  return target.workspace ? `workspace:${target.workspace.id}` : `machine:${target.machine.id}`
})
const draft = computed({ get: () => agents.drafts[draftKey.value] ?? "", set: value => { agents.drafts[draftKey.value] = value } })
const submitting = ref(false)
const error = ref<string | null>(null)
async function submit(): Promise<void> {
  const target = newSessionTarget.value
  const text = draft.value
  const key = draftKey.value
  if (!target || submitting.value || !text.trim() || !providers.ready || !providers.selectedId) return
  const context = target.workspace ? sessionContext.value : "directory"
  submitting.value = true
  error.value = null
  try {
    const snapshot = await agents.create(target.workspace?.id, text.trim().split("\n")[0]!.slice(0, 100), context, providers.selectedId)
    const id = snapshot.session.id
    agents.drafts[id] = text
    if (agents.drafts[key] === text) agents.drafts[key] = ""
    await fleet.refreshLocalCatalog()
    const sameTarget = newSessionTarget.value?.workspace?.id === target.workspace?.id
      && newSessionTarget.value?.machine.id === target.machine.id
    if (router.currentRoute.value.name === "new-session" && sameTarget) await router.push({ name: "session", params: { sessionId: id } })
    // A rejected or disconnected submission remains in the Session draft for reconciliation.
    if (snapshot.session.lifecycle === "ready") await agents.submit(id, text, "backlog").catch(() => {})
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { submitting.value = false }
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
  <SessionComposer v-model="draft" v-model:context="sessionContext" :location="newSessionTarget" :disabled="!newSessionTarget?.machine.online || !providers.ready || !providers.selectedId" :submitting="submitting" show-target @submit="submit" />
</template>
