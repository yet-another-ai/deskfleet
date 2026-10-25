<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { RouteResource } from "../../composables/useRouteResource.ts"
import { useWorktreeLabel } from "../../composables/useWorktreeLabel.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import type { DirectoryBinding, MachineSummary } from "../../stores/fleet-types.ts"
import DetailsList, { type DetailsRow } from "./DetailsList.vue"

const props = defineProps<{ resource: RouteResource }>()
const { t } = useI18n()
const worktreeLabel = useWorktreeLabel()
const sessionLabel = useSessionLabel()

function machineStatus(machine: MachineSummary): string {
  return machine.online ? t("panel.online") : t("machine.offline")
}

const rows = computed<DetailsRow[]>(() => {
  const resource = props.resource
  const machine = { label: t("panel.machine"), value: resource.machine.name }
  switch (resource.kind) {
    case "workspace":
      return [machine, { label: t("panel.status"), value: machineStatus(resource.machine) }]
    case "worktree":
      return [
        machine,
        { label: t("panel.workspace"), value: resource.workspace.name },
        { label: t("worktree.session"), value: sessionLabel(resource.session) },
        { label: t("panel.status"), value: machineStatus(resource.machine) },
      ]
    case "session":
      return [
        ...(resource.session.provider ? [{ label: t("panel.provider"), value: resource.session.provider }] : []),
        machine,
        { label: t("panel.workspace"), value: resource.workspace.name },
      ]
    case "terminal": {
      const scope = resource.worktree
        ? t("panel.scopeWorktree")
        : resource.workspace
          ? t("panel.scopeWorkspace")
          : t("panel.scopeMachine")
      return [
        { label: t("panel.scope"), value: scope },
        machine,
        ...(resource.workspace ? [{ label: t("panel.workspace"), value: resource.workspace.name }] : []),
        ...(resource.session ? [{ label: t("worktree.session"), value: sessionLabel(resource.session) }] : []),
        ...(resource.worktree ? [{ label: t("panel.worktree"), value: worktreeLabel(resource.session) }] : []),
        { label: t("panel.cwd"), value: resource.terminal.cwd, code: true },
      ]
    }
    case "desktop":
      return [
        machine,
        { label: t("panel.status"), value: machineStatus(resource.machine) },
        {
          label: t("panel.display"),
          value: resource.machine.desktop ? t("panel.displayAvailable") : t("panel.displayNone"),
        },
      ]
  }
})

const title = computed(() => {
  const resource = props.resource
  switch (resource.kind) {
    case "workspace":
      return resource.workspace.name
    case "worktree":
      return worktreeLabel(resource.session)
    case "session":
      return sessionLabel(resource.session)
    case "terminal":
      return resource.terminal.title
    case "desktop":
      return t("machine.remoteDesktop")
  }
})

const directories = computed<DirectoryBinding[]>(() => {
  const resource = props.resource
  if (resource.kind === "desktop") return []
  if (resource.kind === "workspace") return resource.workspace.directories
  return resource.worktree?.directories ?? []
})
</script>

<template>
  <div class="flex flex-col gap-5">
    <h2 class="m-0 break-words text-sm font-semibold">{{ title }}</h2>
    <DetailsList :rows="rows" />

    <section v-if="directories.length">
      <h3 class="ui-section-title mb-2">{{ t("panel.directories") }}</h3>
      <ul class="flex flex-col gap-3">
        <li v-for="(directory, index) in directories" :key="index" class="text-[13px]">
          <div v-if="index === 0" class="mb-1 text-xs text-ui-text-muted">{{ t("catalog.defaultDirectory") }}</div>
          <div class="break-all font-mono text-xs text-ui-text-muted select-text">
            {{ directory.path }}
          </div>
          <div v-if="directory.git" class="mt-0.5 font-mono text-xs text-ui-text-faint select-text">
            {{ directory.git.branch }} · {{ directory.git.head }}
          </div>
          <div v-else-if="directory.git === null" class="mt-0.5 text-xs text-ui-text-faint">{{ t("panel.notGit") }}</div>
        </li>
      </ul>
    </section>
  </div>
</template>
