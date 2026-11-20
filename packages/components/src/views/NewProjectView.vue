<script setup lang="ts">
import { onScopeDispose, ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ErrorNotice from "../components/common/ErrorNotice.vue"
import FolderPickerDialog from "../components/common/FolderPickerDialog.vue"
import UiButton from "../components/common/UiButton.vue"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { workspaceAgentRoute } from "../services/workspace-agent-navigation.ts"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useFleetStore } from "../stores/fleet.ts"

const { t } = useI18n()
const client = usePlatformClient()
const fleet = useFleetStore()
const account = useAccountSession()
const projectRoute = (id: string | null) => workspaceAgentRoute(fleet.targetId, id, account?.teamId.value)
const router = useRouter()
const route = useRoute()
const picking = ref(true)
const saving = ref(false)
const error = shallowRef<unknown>()
let active = true
onScopeDispose(() => { active = false })

function cancel() {
  const id = route.query.fromProject
  if (typeof id === "string" && fleet.findWorkspace(id)) {
    void router.replace(projectRoute(id))
  } else void router.replace(projectRoute(null))
}

async function create(path: string) {
  if (!active || saving.value || !picking.value) return
  picking.value = false
  saving.value = true
  error.value = undefined
  try {
    if (!fleet.canManageCatalog) await fleet.refreshLocal()
    if (!active) return
    // The picker returns an absolute path on its own host, which may run another OS.
    const separator = /^(?:[a-z]:[\\/]|\\\\)/iu.test(path) ? /[\\/]/u : "/"
    const name = path.split(separator).filter(Boolean).at(-1) ?? path
    const project = await fleet.createWorkspace(name, [{ path }])
    if (active && router.currentRoute.value.name === "new-project") {
      await router.replace(projectRoute(project.id))
    }
  } catch (reason) {
    if (active) error.value = reason
  } finally { saving.value = false }
}
</script>

<template>
  <PaneHeader>{{ t("superAgent.newProject") }}</PaneHeader>
  <FolderPickerDialog v-if="picking" :browse="client.filesystem.listDirectories" :machine-name="account?.machine.value?.name ?? fleet.localDesktopTarget.name" @select="create" @cancel="cancel" />
  <div v-else class="flex min-h-0 flex-1 items-center justify-center px-6">
    <p v-if="saving" role="status" class="text-sm text-ui-text-muted">{{ t("catalog.saving") }}</p>
    <ErrorNotice v-else-if="error" :error="error" class="w-full max-w-lg">
      <UiButton @click="picking = true">{{ t("folderPicker.title") }}</UiButton>
      <UiButton @click="cancel">{{ t("catalog.cancel") }}</UiButton>
    </ErrorNotice>
  </div>
</template>
