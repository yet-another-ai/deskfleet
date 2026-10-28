<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"
import { computed, ref, useTemplateRef, watch } from "vue"
import type { AgentEvent, AgentInput, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { projectConversation } from "../../services/agent-conversation.ts"

interface OutlineItem {
  id: string
  label: string
  reply?: string
  width: number
}

const props = defineProps<{ events: AgentEvent[]; snapshot: AgentSnapshot; active?: string }>()
const emit = defineEmits<{ select: [id: string] }>()

const list = useTemplateRef<HTMLOListElement>("list")
const hovered = ref<string>()

const items = computed<OutlineItem[]>(() => {
  const result: OutlineItem[] = []
  for (const entry of projectConversation(props.events, props.snapshot)) {
    if (entry.kind === "input") {
      const label = plainText(entry.input.content)
      const width = 6 + (22 * label.length) / (label.length + 10)
      result.push({ id: entry.id, label, width })
      continue
    }
    if (entry.kind === "message" && entry.role === "assistant" && result.length) {
      const reply = plainText(entry.content)
      if (reply) result.at(-1)!.reply = reply
    }
  }
  return result
})

const hoveredIndex = computed(() => items.value.findIndex(item => item.id === hovered.value))
const highlighted = computed(() => hovered.value ?? props.active)

function plainText(content: AgentInput["content"]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "resource" && "text" in block.resource) parts.push(block.resource.text)
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim()
}

function tickWidth(index: number, baseline: number): number {
  if (hoveredIndex.value < 0) return baseline
  const distance = Math.abs(index - hoveredIndex.value)
  return distance <= 3 ? 32 - distance * 5 : baseline
}

watch(() => props.active, () => {
  list.value?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "nearest" })
}, { flush: "post" })
</script>

<template>
  <nav v-if="items.length" class="flex max-h-full w-8 flex-col">
    <TooltipProvider :delay-duration="250">
      <ol ref="list" class="min-h-0 overflow-y-auto [scrollbar-width:none]">
        <li v-for="(item, index) in items" :key="item.id">
          <TooltipRoot>
            <TooltipTrigger
              type="button"
              :aria-label="item.label"
              :aria-current="active === item.id ? 'location' : undefined"
              class="group flex h-2 w-8 cursor-pointer items-center rounded-sm"
              @pointerenter="hovered = item.id"
              @pointerleave="hovered = undefined"
              @click="emit('select', item.id)"
            >
              <span
                aria-hidden="true"
                :style="{ width: `${tickWidth(index, item.width)}px` }"
                class="h-0.5 shrink-0 rounded-full transition-[width,background-color] duration-150 ease-out"
                :class="highlighted === item.id ? 'bg-ui-accent' : 'bg-ui-text-muted/45 group-focus-visible:bg-ui-text-muted'"
              />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                side="right"
                :side-offset="8"
                :collision-padding="8"
                class="ui-tooltip z-70 max-w-72 break-words rounded-md border border-ui-border bg-ui-surface px-2.5 py-1.5 text-xs leading-5 text-ui-text shadow-ui-popover"
              >
                <p class="m-0 truncate font-medium">{{ item.label }}</p>
                <p
                  v-if="item.reply"
                  class="m-0 mt-1.5 overflow-hidden text-ui-text-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]"
                >
                  {{ item.reply }}
                </p>
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </li>
      </ol>
    </TooltipProvider>
  </nav>
</template>
