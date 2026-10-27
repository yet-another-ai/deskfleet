<script setup lang="ts">
import { ChevronDown, ExternalLink, LoaderCircle, RefreshCw } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from "reka-ui"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { LocalApplicationsApi } from "../../../../client/src/applications.ts"
import ApplicationIcon from "./ApplicationIcon.vue"

const props = defineProps<{
  api: LocalApplicationsApi
  machineId: string
  workspaceId: string
  directoryIndex?: number
  directoryPath?: string
  compact?: boolean
  disabled?: boolean
}>()
const { t } = useI18n()
const open = ref(false)
const launching = ref(false)
const launchError = ref<string>()
const { state: applications, isLoading: scanning, error: scanError, executeImmediate: scan } = useAsyncState(
  () => props.api.scan(), [], { immediate: false, onError: () => {} },
)
const label = computed(() => props.directoryPath
  ? t("applications.openDirectory", { path: props.directoryPath }) : t("applications.openDefault"))
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
type Application = Awaited<ReturnType<LocalApplicationsApi["scan"]>>[number]
const applicationName = (application: Application) => application.kind === "editor"
  ? application.name : t(`applications.${application.kind}`)

function changeOpen(value: boolean): void {
  open.value = value
  if (value && !scanning.value) void scan()
}
async function launch(application: Application): Promise<void> {
  if (props.disabled || launching.value) return
  launching.value = true
  launchError.value = undefined
  try {
    await props.api.openWorkspace({
      applicationId: application.id, machineId: props.machineId, workspaceId: props.workspaceId,
      ...(props.directoryIndex === undefined ? {} : { directoryIndex: props.directoryIndex }),
    })
  } catch (reason) {
    launchError.value = t("applications.launchFailed", { name: applicationName(application), message: message(reason) })
  } finally { launching.value = false }
}
</script>

<template>
  <div class="min-w-0">
    <DropdownMenuRoot :open="open" :modal="false" @update:open="changeOpen">
      <DropdownMenuTrigger class="ui-button" :class="compact ? 'h-7 w-7 shrink-0 p-0' : 'h-8 px-3'" :disabled="disabled || launching" :aria-busy="launching || undefined" :aria-label="label" :title="label">
        <LoaderCircle v-if="launching" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
        <ExternalLink v-else :size="15" aria-hidden="true" />
        <template v-if="!compact">{{ t("applications.openWith") }}<ChevronDown :size="13" aria-hidden="true" /></template>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent :aria-label="label" align="end" :side-offset="4" :collision-padding="8" class="ui-menu z-50 max-w-80 min-w-56" loop>
          <p v-if="scanning" role="status" class="m-0 flex items-center gap-2 px-2.5 py-2 text-sm text-ui-text-muted"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t("applications.scanning") }}</p>
          <p v-else-if="scanError" role="alert" class="m-0 break-words px-2.5 py-2 text-sm text-ui-danger">{{ t("applications.scanFailed", { message: message(scanError) }) }}</p>
          <p v-else-if="applications.length === 0" role="status" class="m-0 px-2.5 py-2 text-sm text-ui-text-muted">{{ t("applications.empty") }}</p>
          <template v-else>
            <DropdownMenuItem v-for="application in applications" :key="application.id" as="button" type="button" class="ui-menu-item w-full" :disabled="disabled || launching" @select="launch(application)">
              <ApplicationIcon :application="application" />{{ applicationName(application) }}
            </DropdownMenuItem>
          </template>
          <DropdownMenuSeparator class="my-1 border-t border-ui-border" />
          <DropdownMenuItem as="button" type="button" class="ui-menu-item w-full" :disabled="scanning" @select.prevent="scan()"><RefreshCw :size="14" aria-hidden="true" />{{ t("applications.rescan") }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
    <p v-if="launchError" role="alert" class="m-0 mt-2 max-w-80 break-words text-xs text-ui-danger">{{ launchError }}</p>
  </div>
</template>
