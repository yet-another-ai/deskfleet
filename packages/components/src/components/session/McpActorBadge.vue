<script setup lang="ts">
import type { AgentActor } from "@deskfleet/protocol/agent"
import { Bot, Orbit } from "@lucide/vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useAgentActor } from "../../composables/useAgentActor.ts"
import SpringSurface from "../common/SpringSurface.ts"
import UserAvatar from "../common/UserAvatar.vue"

const props = defineProps<{ actor: AgentActor; creator?: boolean; large?: boolean }>()
const { t } = useI18n()
const { name, email, mcpSender } = useAgentActor(() => props.actor)
const title = computed(() => t(props.creator ? "agent.mcpAttribution.created" : "agent.mcpAttribution.sent", { sender: mcpSender.value }))
const authorization = computed(() => props.actor.userId ? t("agent.mcpAttribution.authorizedBy", { name: name.value }) : undefined)
const label = computed(() => authorization.value ? `${title.value} · ${authorization.value}` : title.value)
</script>

<template>
  <span class="inline-flex shrink-0 items-center">
    <PopoverRoot>
      <PopoverTrigger
        type="button"
        :aria-label="label"
        :title="label"
        class="relative inline-flex cursor-pointer items-center justify-center rounded-lg bg-ui-accent/10 text-ui-accent outline-offset-2 ui-motion hover:bg-ui-accent/20"
        :class="large ? 'h-8 w-8' : 'h-6 w-6'"
      >
        <component :is="actor.via === 'super_agent_mcp' ? Orbit : Bot" :size="large ? 20 : 16" :stroke-width="1.75" aria-hidden="true" />
        <span v-if="actor.userId" class="pointer-events-none absolute -bottom-0.5 -right-0.5 flex rounded-full ring-2 ring-ui-canvas" aria-hidden="true">
          <UserAvatar :name="name" :email="email" :size="large ? 16 : 12" />
        </span>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent :as="SpringSurface" :aria-label="title" :side-offset="8" :collision-padding="8" class="ui-card z-70 max-w-[min(18rem,calc(100vw-1rem))] px-3 py-2 text-xs leading-5 shadow-ui-popover">
          <div class="font-medium text-ui-text">{{ title }}</div>
          <div v-if="authorization" class="mt-0.5 flex items-center gap-1.5 text-ui-text-muted">
            <UserAvatar :name="name" :email="email" :size="18" />
            <span class="min-w-0 break-words">{{ authorization }}</span>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </span>
</template>
