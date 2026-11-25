<script setup lang="ts">
import SpringCollapse from "../common/SpringCollapse.vue"
import SpringSurface from "../common/SpringSurface.ts"
import UiButton from "../common/UiButton.vue"
import { useResizeObserver } from "@vueuse/core"
import { ArrowRightLeft, Bot, Brain, ChevronDown, ChevronLeft, ChevronRight, FilePen, FileText, Globe, Monitor, Repeat, Search, ShieldAlert, SquareTerminal, Trash2, Wrench } from "@lucide/vue"
import { CollapsibleRoot, CollapsibleTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, inject, nextTick, ref, useTemplateRef, watch, type Component } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentPermission } from "@deskfleet/protocol/agent"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import { remoteMcpTool } from "../../services/remote-mcp-tool.ts"
import { toolCallSummary } from "../../services/tool-call-summary.ts"
import AgentToolDetails from "./AgentToolDetails.vue"

const props = defineProps<{ permissions: AgentPermission[]; disabled: boolean }>()
const emit = defineEmits<{ respond: [id: string, optionId: string] }>()
const { t } = useI18n()
const account = useAccountSession()
const resourceContext = inject(agentResourceContextKey, undefined)

const icons: Record<string, Component> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Repeat,
}

// Answered requests are recorded on their tool call in the conversation.
const pending = computed(() => props.permissions.filter(permission => permission.state === "pending"))
const activeIndex = ref(0)
const detailsOpen = ref(false)
const subject = useTemplateRef<HTMLElement>("subject")
const truncated = ref(false)

const current = computed(() => pending.value[activeIndex.value] ?? pending.value[0])
const tool = computed(() => current.value?.request.toolCall)
const remote = computed(() => tool.value ? remoteMcpTool(tool.value) : undefined)
const summary = computed(() => tool.value ? toolCallSummary(tool.value) : undefined)
const label = computed(() => {
  if (!tool.value) return ""
  return summary.value ? t(`agent.toolCall.${summary.value.kind}`, { target: summary.value.target }) : tool.value.title || t("agent.tool")
})
const subjectText = computed(() => {
  if (remote.value) return remote.value.action || remote.value.toolName
  if (summary.value?.kind === "execute") return summary.value.target
  return label.value
})
const icon = computed<Component>(() => {
  if (remote.value) return Monitor
  if (tool.value?.content?.some(block => block.type === "terminal")) return Bot
  return icons[summary.value?.kind ?? tool.value?.kind ?? ""] ?? Wrench
})
const machineName = computed(() => {
  if (!remote.value) return undefined
  const target = resourceContext?.value?.target
  const teamId = target?.kind === "machine" ? target.teamId : account?.teamId.value
  return account?.machines.value.find(machine => machine.id === remote.value!.machineId && machine.teamId === teamId)?.name || remote.value.machineId
})
const hasDetails = computed(() => Boolean(tool.value && (tool.value.locations?.length || tool.value.rawInput != null || tool.value.content?.length || tool.value.rawOutput != null)))
const canExpand = computed(() => hasDetails.value || truncated.value || detailsOpen.value)

function measureTruncation(): void {
  const el = subject.value
  if (!el || detailsOpen.value) return
  truncated.value = el.scrollWidth > el.clientWidth + 1
}

useResizeObserver(subject, measureTruncation)

const groupedOptions = computed(() => {
  const options = current.value?.request.options ?? []
  const allow = options.filter(option => option.kind.startsWith("allow"))
  const reject = options.filter(option => option.kind.startsWith("reject"))
  const other = options.filter(option => !option.kind.startsWith("allow") && !option.kind.startsWith("reject"))
  const primaryAllow = allow.find(option => option.kind === "allow_once") ?? allow[0]
  const extraAllow = allow.filter(option => option !== primaryAllow)
  const primaryReject = reject.find(option => option.kind === "reject_once") ?? reject[0]
  const extraReject = reject.filter(option => option !== primaryReject)
  return { primaryAllow, extraAllow, primaryReject, extraReject, other }
})

watch(() => pending.value.length, length => {
  if (length === 0) activeIndex.value = 0
  else if (activeIndex.value >= length) activeIndex.value = length - 1
})

watch([() => current.value?.id, subjectText], () => {
  detailsOpen.value = false
  truncated.value = false
  void nextTick(measureTruncation)
}, { immediate: true })

watch(detailsOpen, open => {
  if (!open) void nextTick(measureTruncation)
})

function respond(optionId: string): void {
  if (!current.value || props.disabled) return
  emit("respond", current.value.id, optionId)
}
</script>

<template>
  <section v-if="current && tool" class="flex flex-col gap-2" :aria-label="t('agent.permissions')">
    <div :key="current.id" class="ui-attention relative z-1 rounded-xl border border-ui-warning/40 bg-ui-surface px-3 py-2" :data-permission-id="current.id">
      <div class="flex items-center gap-1.5 text-xs text-ui-text-muted">
        <ShieldAlert :size="14" :stroke-width="1.75" class="shrink-0 text-ui-warning" aria-hidden="true" />
        <span class="shrink-0 font-medium">{{ t('agent.permissionRequired') }}</span>
        <template v-if="remote && machineName">
          <span class="shrink-0" aria-hidden="true">·</span>
          <span class="truncate">{{ machineName }} · {{ remote.serverId }}</span>
        </template>
        <div v-if="pending.length > 1" class="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-permission-prev
            class="-my-0.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ui-text-muted ui-motion hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:op-35"
            :disabled="activeIndex === 0"
            :aria-label="t('agent.permissionPrevious')"
            @click="activeIndex--"
          >
            <ChevronLeft :size="13" :stroke-width="2" aria-hidden="true" />
          </button>
          <span class="px-0.5 tabular-nums" data-permission-queue>{{ activeIndex + 1 }} / {{ pending.length }}</span>
          <button
            type="button"
            data-permission-next
            class="-my-0.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ui-text-muted ui-motion hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:op-35"
            :disabled="activeIndex >= pending.length - 1"
            :aria-label="t('agent.permissionNext')"
            @click="activeIndex++"
          >
            <ChevronRight :size="13" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>

      <CollapsibleRoot v-model:open="detailsOpen" :disabled="!canExpand" class="mt-1">
        <CollapsibleTrigger
          type="button"
          data-permission-details
          :title="canExpand ? t('agent.remoteMcp.details') : undefined"
          class="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 gap-2 rounded-lg px-1.5 py-1 text-left ui-motion"
          :class="[detailsOpen ? 'items-start' : 'items-center', canExpand ? 'cursor-pointer hover:bg-ui-hover/60' : 'cursor-default']"
        >
          <component :is="icon" :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" :class="detailsOpen && 'mt-0.5'" aria-hidden="true" />
          <span
            ref="subject"
            class="min-w-0 flex-1 text-[13px] font-medium leading-5 text-ui-text"
            :class="[
              summary?.kind === 'execute' && 'font-mono',
              detailsOpen ? (summary?.kind === 'execute' ? 'whitespace-normal break-all select-text' : 'whitespace-normal break-words select-text') : 'truncate',
            ]"
            :title="detailsOpen ? undefined : subjectText"
          >{{ subjectText }}</span>
          <ChevronDown v-if="canExpand" :size="14" :stroke-width="1.75" class="shrink-0 text-ui-text-muted transition-transform duration-150" :class="[detailsOpen && 'mt-0.5 rotate-180']" aria-hidden="true" />
        </CollapsibleTrigger>
        <SpringCollapse v-if="hasDetails" class="ui-collapsible">
          <div class="mt-1.5 rounded-lg border border-ui-border bg-ui-canvas/50 p-2.5">
            <!-- Remote resource paths must not resolve against the source Agent's machine. -->
            <AgentToolDetails :tool="tool" :raw-content="Boolean(remote)" />
          </div>
        </SpringCollapse>
      </CollapsibleRoot>

      <div class="mt-1.5 flex items-center justify-end gap-2">
        <UiButton
          v-for="option in groupedOptions.other"
          :key="option.optionId"
          size="sm"
          :disabled="disabled"
          @click="respond(option.optionId)"
        >
          {{ option.name }}
        </UiButton>

        <template v-if="groupedOptions.primaryReject">
          <div v-if="groupedOptions.extraReject.length" class="inline-flex items-stretch">
            <button
              type="button"
              class="ui-button h-7 rounded-r-none px-2.5 text-xs"
              :disabled="disabled"
              @click="respond(groupedOptions.primaryReject.optionId)"
            >
              {{ groupedOptions.primaryReject.name }}
            </button>
            <DropdownMenuRoot :modal="false">
              <DropdownMenuTrigger
                type="button"
                data-permission-more-reject
                class="ui-button -ml-px h-7 rounded-l-none px-1.5"
                :disabled="disabled"
                :aria-label="t('agent.permissionMoreOptions')"
              >
                <ChevronDown :size="13" :stroke-width="2" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent :as="SpringSurface" side="top" align="end" :side-offset="6" :collision-padding="8" class="ui-menu z-50 min-w-44 max-w-[min(22rem,calc(100vw-2rem))]" loop>
                  <DropdownMenuItem
                    v-for="option in groupedOptions.extraReject"
                    :key="option.optionId"
                    class="ui-menu-item whitespace-normal leading-snug"
                    @select="respond(option.optionId)"
                  >
                    {{ option.name }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </div>
          <UiButton
            v-else
            size="sm"
            :disabled="disabled"
            @click="respond(groupedOptions.primaryReject.optionId)"
          >
            {{ groupedOptions.primaryReject.name }}
          </UiButton>
        </template>

        <template v-if="groupedOptions.primaryAllow">
          <div v-if="groupedOptions.extraAllow.length" class="inline-flex items-stretch">
            <button
              type="button"
              class="ui-button-primary h-7 rounded-r-none px-2.5 text-xs"
              :disabled="disabled"
              @click="respond(groupedOptions.primaryAllow.optionId)"
            >
              {{ groupedOptions.primaryAllow.name }}
            </button>
            <DropdownMenuRoot :modal="false">
              <DropdownMenuTrigger
                type="button"
                data-permission-more-allow
                class="ui-button-primary h-7 rounded-l-none border-l border-l-ui-action-text/20 px-1.5"
                :disabled="disabled"
                :aria-label="t('agent.permissionMoreOptions')"
              >
                <ChevronDown :size="13" :stroke-width="2" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent :as="SpringSurface" side="top" align="end" :side-offset="6" :collision-padding="8" class="ui-menu z-50 min-w-48 max-w-[min(22rem,calc(100vw-2rem))]" loop>
                  <DropdownMenuItem
                    v-for="option in groupedOptions.extraAllow"
                    :key="option.optionId"
                    class="ui-menu-item whitespace-normal leading-snug"
                    @select="respond(option.optionId)"
                  >
                    {{ option.name }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </div>
          <UiButton
            v-else
            size="sm"
            variant="primary"
            :disabled="disabled"
            @click="respond(groupedOptions.primaryAllow.optionId)"
          >
            {{ groupedOptions.primaryAllow.name }}
          </UiButton>
        </template>
      </div>
    </div>
  </section>
</template>
