<script setup lang="ts">
import { vSpring } from "../../directives/spring.ts"
import { vSpringEnter } from "../../directives/spring.ts"
import { ChevronRight, LoaderCircle } from "@lucide/vue"
import { DropdownMenuItem, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "reka-ui"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentQuotaItem } from "../../../../client/src/agent-configuration.ts"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import UiScrollArea from "../common/UiScrollArea.vue"

const props = defineProps<{ providerId: string; open: boolean }>()
const emit = defineEmits<{ "update:open": [value: boolean] }>()
const { t, locale } = useI18n()
const agents = useAgentSessionsStore()
const items = ref<AgentQuotaItem[] | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let requestId = 0

const percentFormat = computed(() => new Intl.NumberFormat(intlLocale(locale.value as AppLocale), { style: "percent", maximumFractionDigits: 0 }))
const resetFormat = computed(() => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))

function formatReset(value?: string): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? t("composer.usageResetsAt", { time: resetFormat.value.format(parsed) }) : undefined
}

const groups = computed(() => {
  const result: { name?: string; items: (AgentQuotaItem & { resetText?: string })[] }[] = []
  for (const item of items.value ?? []) {
    const entry = { ...item, resetText: formatReset(item.resetsAt) }
    const last = result.at(-1)
    if (last && last.name === item.group) last.items.push(entry)
    else result.push({ name: item.group, items: [entry] })
  }
  return result
})

async function load(): Promise<void> {
  const id = ++requestId
  loading.value = true
  error.value = null
  try {
    const quota = await agents.agentUsage(props.providerId)
    if (id === requestId) items.value = quota
  } catch (reason) {
    if (id === requestId) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (id === requestId) loading.value = false
  }
}

watch(() => [props.providerId, props.open] as const, ([providerId, isOpen], previous) => {
  if (previous && providerId !== previous[0]) {
    requestId++
    items.value = null
    error.value = null
    loading.value = false
  }
  if (isOpen && items.value === null && !loading.value) void load()
}, { immediate: true })

function meterTone(remaining: number): string {
  if (remaining <= 0.05) return "bg-ui-danger"
  if (remaining <= 0.2) return "bg-ui-warning"
  return "bg-ui-accent"
}
</script>

<template>
  <DropdownMenuSub :open="open" @update:open="emit('update:open', $event)">
    <DropdownMenuSubTrigger as="button" type="button" data-agent-view-usage class="ui-menu-item gap-3 focus:outline-none" :class="open && 'bg-ui-hover'">
      <span class="flex-1 text-left">{{ t("composer.viewUsage") }}</span>
      <LoaderCircle v-if="loading" :size="13" class="shrink-0 animate-spin text-ui-text-muted" aria-hidden="true" />
      <ChevronRight :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
    </DropdownMenuSubTrigger>
    <DropdownMenuPortal>
      <DropdownMenuSubContent as-child data-agent-usage-menu :aria-label="t('composer.viewUsage')" :side-offset="4" :collision-padding="8" class="ui-menu z-50 flex max-h-[min(22rem,var(--reka-popper-available-height))] w-68 max-w-[calc(100vw-16px)] flex-col overflow-hidden p-0"><div v-spring-enter>
        <UiScrollArea :focusable="false" fade-size="sm" class="min-h-0 flex-auto" content-class="p-3">
          <p v-if="loading && !items?.length" role="status" class="m-0 flex items-center gap-1.5 text-xs text-ui-text-muted">
            <LoaderCircle :size="13" class="shrink-0 animate-spin" aria-hidden="true" />{{ t("composer.loading") }}
          </p>
          <div v-else-if="error" class="text-xs">
            <p role="alert" class="m-0 break-words text-ui-danger">{{ error }}</p>
            <DropdownMenuItem as="button" type="button" class="ui-menu-item -mx-2 mt-2" @select.prevent="load">{{ t("composer.reloadConfiguration") }}</DropdownMenuItem>
          </div>
          <p v-else-if="!groups.length" class="m-0 text-xs text-ui-text-muted">{{ t("composer.usageEmpty") }}</p>
          <div v-else class="flex flex-col gap-3">
            <div v-for="(group, groupIndex) in groups" :key="group.name ?? groupIndex" class="flex flex-col gap-2.5">
              <div v-if="group.name" class="text-xs font-medium text-ui-text-muted">{{ group.name }}</div>
              <div v-for="item in group.items" :key="item.id" data-agent-quota-item :data-quota-id="item.id" class="flex flex-col gap-1">
                <div class="flex items-baseline justify-between gap-3 text-xs">
                  <span class="truncate">{{ item.label }}</span>
                  <span class="shrink-0 tabular-nums text-ui-text-muted">{{ percentFormat.format(item.remaining) }}</span>
                </div>
                <div role="progressbar" :aria-label="item.label" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="Math.round(item.remaining * 100)" class="ui-meter">
                  <div class="ui-meter-fill" :class="meterTone(item.remaining)" v-spring.enter="{ width: `${item.remaining * 100}%` }" />
                </div>
                <span v-if="item.resetText" class="text-[11px] text-ui-text-faint">{{ item.resetText }}</span>
              </div>
            </div>
          </div>
        </UiScrollArea>
      </div></DropdownMenuSubContent>
    </DropdownMenuPortal>
  </DropdownMenuSub>
</template>
