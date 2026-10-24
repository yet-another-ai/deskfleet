<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import DirectoryList from "../components/catalog/DirectoryList.vue"
import { useWorktreeLabel } from "../composables/useWorktreeLabel.ts"
import { useSessionLabel } from "../composables/useSessionLabel.ts"
import { useFleetStore } from "../stores/fleet.ts"

const props = defineProps<{ worktreeId: string }>()
const { t } = useI18n()
const worktreeLabel = useWorktreeLabel()
const sessionLabel = useSessionLabel()
const fleet = useFleetStore()
const location = computed(() => fleet.findWorktree(props.worktreeId))
const available = computed(() => fleet.canManageCatalog && location.value?.machine.local)
</script>

<template>
  <PaneHeader>
    <template v-if="location">
      {{ worktreeLabel(location.session) }}
      <ResourcePath :segments="[location.machine.name, location.workspace.name, sessionLabel(location.session)]" />
    </template>
  </PaneHeader>
  <div v-if="!location" class="flex min-h-0 flex-1 items-center justify-center px-6 text-ui-text-muted">
    {{ fleet.catalogLoading ? t("catalog.loading") : t("worktree.notFound") }}
  </div>
  <div v-else class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-3xl flex-col gap-8 px-6 pb-8 pt-4">
      <p v-if="!available" class="m-0 text-sm text-ui-text-muted">{{ t("catalog.offline") }}</p>
      <section>
        <h2 class="ui-section-title">{{ t("worktree.directories") }}</h2>
        <DirectoryList :directories="location.worktree.directories" :disabled="!available" :owner="{ sessionId: location.session.id, worktreeId: location.worktree.id }" />
      </section>
      <section>
        <h2 class="ui-section-title">{{ t("worktree.session") }}</h2>
        <ul class="ui-card">
          <li>
            <RouterLink :to="{ name: 'session', params: { sessionId: location.session.id } }" class="ui-card-row hover:bg-ui-hover">{{ sessionLabel(location.session) }}</RouterLink>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
