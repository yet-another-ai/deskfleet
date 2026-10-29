<script setup lang="ts">
import UiButton from "../components/common/UiButton.vue"
import { usePlatformClient } from "../composables/usePlatformClient.ts"

import { SquarePen } from "@lucide/vue"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import type { CatalogDirectory } from "../../../client/src/catalog.ts"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import ConfirmDelete from "../components/catalog/ConfirmDelete.vue"
import DirectoryList from "../components/catalog/DirectoryList.vue"
import OpenWithMenu from "../components/catalog/OpenWithMenu.vue"
import WorkspaceForm from "../components/catalog/WorkspaceForm.vue"
import { useSessionLabel } from "../composables/useSessionLabel.ts"
import { useFleetStore } from "../stores/fleet.ts"

const platformClient = usePlatformClient()

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const sessionLabel = useSessionLabel()
const fleet = useFleetStore()
const router = useRouter()
const location = computed(() => fleet.findWorkspace(props.workspaceId))
const editable = computed(() => fleet.canManageCatalog && location.value?.machine.online)
const directories = computed(() => location.value?.workspace.directories ?? [])
const applicationTarget = computed(() => platformClient.platform !== "web" && location.value?.machine.local && platformClient.applications
  ? { api: platformClient.applications, machineId: location.value.machine.id, workspaceId: props.workspaceId } : undefined)
const editing = ref(false)
const browseDirectories = platformClient.filesystem.listDirectories
watch(() => props.workspaceId, () => { editing.value = false })
function startSession(): void {
  fleet.targetWorkspace(props.workspaceId)
  void router.push({ name: "new-session" })
}
async function save(name: string, paths: CatalogDirectory[]): Promise<void> {
  await fleet.updateWorkspace(props.workspaceId, name, paths)
  editing.value = false
}
async function remove(): Promise<void> {
  await fleet.deleteWorkspace(props.workspaceId)
  await router.push({ name: "new-session" })
}
</script>

<template>
  <PaneHeader>
    <template v-if="location">
      {{ location.workspace.name }}
      <ResourcePath :segments="[location.machine.name]" />
    </template>
  </PaneHeader>
  <div v-if="!location" class="flex min-h-0 flex-1 items-center justify-center px-6 text-ui-text-muted">
    {{ fleet.catalogLoading ? t("catalog.loading") : t("workspace.notFound") }}
  </div>
  <div v-else class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-3xl flex-col gap-8 px-6 pb-10 pt-6">
      <p v-if="!editable" class="ui-notice m-0 border-ui-border bg-ui-surface text-ui-text-muted">{{ t("catalog.offline") }}</p>
      <section>
        <div class="ui-section-header">
          <h2 class="ui-section-title">{{ t("worktree.directories") }}</h2>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <OpenWithMenu v-if="applicationTarget" :key="workspaceId" v-bind="applicationTarget" :disabled="!editable || editing || directories.length === 0" />
            <UiButton type="button" :disabled="!editable || editing" @click="editing = true">{{ t("workspace.edit") }}</UiButton>
          </div>
        </div>
        <WorkspaceForm v-if="editing" :key="workspaceId" class="ui-card p-4" :initial="{ name: location.workspace.name, directories }" :browse="browseDirectories" :machine-name="location.machine.name" :submit-label="t('catalog.save')" :disabled="!editable" :save="save" @cancel="editing = false" />
        <DirectoryList v-else :key="`directories:${workspaceId}`" :directories="directories" :disabled="!editable" :application-target="applicationTarget" default-action />
      </section>
      <section>
        <div class="ui-section-header">
          <h2 class="ui-section-title">{{ t("workspace.sessions") }}</h2>
          <UiButton variant="ghost" size="sm" type="button" class="cursor-pointer hover:bg-ui-hover" @click="startSession">
            <SquarePen :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("workspace.newSession") }}
          </UiButton>
        </div>
        <ul v-if="location.workspace.sessions.length" class="ui-card">
          <li v-for="session in location.workspace.sessions" :key="session.id">
            <RouterLink :to="{ name: 'session', params: { sessionId: session.id } }" class="ui-card-row hover:bg-ui-hover">
              <span class="min-w-0 flex-1 truncate">{{ sessionLabel(session) }}</span>
              <span v-if="session.provider" class="ui-badge shrink-0">{{ session.provider }}</span>
            </RouterLink>
          </li>
        </ul>
        <p v-else class="ui-empty m-0 py-6 text-[13px] text-ui-text-muted">{{ t("workspace.noSessions") }}</p>
      </section>
      <section class="border-t border-ui-border pt-5">
        <ConfirmDelete :key="workspaceId" :label="t('workspace.delete')" :question="t('workspace.deleteQuestion', { name: location.workspace.name })" :disabled="!editable" :remove="remove" />
      </section>
    </div>
  </div>
</template>
