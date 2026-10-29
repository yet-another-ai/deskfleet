<script setup lang="ts">
import { ChevronDown, ExternalLink, LoaderCircle, RefreshCw } from "@lucide/vue"
import { useAsyncState, useLocalStorage } from "@vueuse/core"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from "reka-ui"
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { LocalApplicationsApi } from "../../../../client/src/applications.ts"
import ApplicationIcon from "./ApplicationIcon.vue"

const props = defineProps<{
  api: LocalApplicationsApi
  machineId: string
  workspaceId?: string
  worktreeId?: string
  directoryIndex?: number
  directoryPath?: string
  compact?: boolean
  split?: boolean
  hideError?: boolean
  disabled?: boolean
}>()
const { t } = useI18n()
const open = ref(false)
const launching = ref(false)
const launchError = ref<string>()
const preferredId = useLocalStorage<string | null>("deskfleet.preferred-application", null)
const { state: applications, isLoading: scanning, error: scanError, executeImmediate: scan } = useAsyncState(
  () => props.api.scan(), [], { immediate: false, onError: () => {} },
)
onMounted(() => {
  if (props.split && !scanning.value) void scan()
})
const label = computed(() => props.directoryPath
  ? t("applications.openDirectory", { path: props.directoryPath }) : t("applications.openDefault"))
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
type Application = Awaited<ReturnType<LocalApplicationsApi["scan"]>>[number]
const applicationName = (application: Application) => application.kind === "editor"
  ? application.name : t(`applications.${application.kind}`)
const visibleApplications = computed(() => props.split
  ? applications.value.filter(application => application.kind === "editor")
  : applications.value)
const primaryApplication = computed(() => visibleApplications.value.find(application => application.id === preferredId.value)
  ?? visibleApplications.value[0])

function changeOpen(value: boolean): void {
  open.value = value
  if (value && !scanning.value) void scan()
}
async function launch(application: Application): Promise<void> {
  if (props.disabled || launching.value) return
  if (application.kind === "editor") preferredId.value = application.id
  launching.value = true
  launchError.value = undefined
  try {
    await props.api.openWorkspace({
      applicationId: application.id, machineId: props.machineId,
      ...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId }),
      ...(props.worktreeId === undefined ? {} : { worktreeId: props.worktreeId }),
      ...(props.directoryIndex === undefined ? {} : { directoryIndex: props.directoryIndex }),
    })
  } catch (reason) {
    launchError.value = t("applications.launchFailed", { name: applicationName(application), message: message(reason) })
  } finally { launching.value = false }
}
defineExpose({ launchError })
</script>

<template>
  <div class="min-w-0" :class="hideError && 'inline-flex items-center'">
    <DropdownMenuRoot :open="open" :modal="false" @update:open="changeOpen">
      <div v-if="split && primaryApplication" class="app-no-drag inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-ui-border bg-transparent text-xs font-medium text-ui-text-muted">
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1.5 px-2 text-ui-text-muted transition-colors enabled:hover:bg-ui-hover enabled:hover:text-ui-text enabled:active:bg-ui-active disabled:cursor-default disabled:op-40"
          :disabled="disabled || launching"
          :aria-busy="launching || undefined"
          @click="launch(primaryApplication)"
        >
          <LoaderCircle v-if="launching" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
          <ApplicationIcon v-else :application="primaryApplication" />
          <span>{{ applicationName(primaryApplication) }}</span>
        </button>
        <DropdownMenuTrigger
          class="inline-flex w-6 shrink-0 cursor-pointer items-center justify-center border-l border-ui-border px-1 text-ui-text-muted transition-colors enabled:hover:bg-ui-hover enabled:hover:text-ui-text enabled:active:bg-ui-active disabled:cursor-default disabled:op-40"
          :disabled="disabled || launching"
          :aria-label="label"
          :title="label"
        >
          <ChevronDown :size="13" aria-hidden="true" />
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuTrigger
        v-else
        :class="[split ? 'ui-button-ghost h-7 px-2 text-xs' : 'ui-button', compact ? 'h-7 w-7 shrink-0 p-0' : !split && 'h-8 px-3']"
        :disabled="disabled || launching"
        :aria-busy="launching || undefined"
        :aria-label="label"
        :title="label"
      >
        <LoaderCircle v-if="launching" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
        <ExternalLink v-else :size="15" aria-hidden="true" />
        <template v-if="!compact">{{ t("applications.openWith") }}<ChevronDown :size="13" aria-hidden="true" /></template>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent :aria-label="label" align="end" :side-offset="4" :collision-padding="8" class="ui-menu z-50 max-w-80 min-w-56" loop>
          <p v-if="scanning" role="status" class="m-0 flex items-center gap-2 px-2.5 py-2 text-sm text-ui-text-muted"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t("applications.scanning") }}</p>
          <p v-else-if="scanError" role="alert" class="m-0 break-words px-2.5 py-2 text-sm text-ui-danger">{{ t("applications.scanFailed", { message: message(scanError) }) }}</p>
          <p v-else-if="visibleApplications.length === 0" role="status" class="m-0 px-2.5 py-2 text-sm text-ui-text-muted">{{ t("applications.empty") }}</p>
          <template v-else>
            <DropdownMenuItem v-for="application in visibleApplications" :key="application.id" as="button" type="button" class="ui-menu-item w-full" :disabled="disabled || launching" @select="launch(application)">
              <ApplicationIcon :application="application" />{{ applicationName(application) }}
            </DropdownMenuItem>
          </template>
          <DropdownMenuSeparator class="my-1 border-t border-ui-border" />
          <DropdownMenuItem as="button" type="button" class="ui-menu-item w-full" :disabled="scanning" @select.prevent="scan()"><RefreshCw :size="14" aria-hidden="true" />{{ t("applications.rescan") }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
    <p v-if="launchError && !hideError" role="alert" class="m-0 mt-2 max-w-80 break-words text-xs text-ui-danger">{{ launchError }}</p>
  </div>
</template>
