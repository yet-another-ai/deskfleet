<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { SessionFace } from "../../services/session-faces.ts"
import UserAvatar from "./UserAvatar.vue"

const props = withDefaults(defineProps<{
  people: SessionFace[]
  size: number
  limit?: number
  surface?: "canvas" | "sidebar"
}>(), { limit: 5, surface: "canvas" })
const { t } = useI18n()
const shown = computed(() => props.people.length > props.limit ? props.people.slice(0, props.limit - 1) : props.people)
const hidden = computed(() => props.people.length > props.limit ? props.people.slice(props.limit - 1) : [])
const ring = computed(() => props.surface === "sidebar" ? "ring-ui-sidebar" : "ring-ui-canvas")
const overlap = computed(() => Math.round(props.size * 0.35))
function label(person: SessionFace): string {
  return t(person.active ? "agent.presenceHere" : "agent.presenceVisited", { name: person.name })
}
</script>

<template>
  <span v-if="people.length" class="inline-flex items-center" role="img" :aria-label="people.map(person => label(person)).join(', ')" data-session-presence>
    <UserAvatar
      v-for="(person, index) in shown"
      :key="person.id"
      :name="person.name"
      :email="person.email"
      :size="size"
      :label="label(person)"
      class="relative ring-2"
      :class="[ring, !person.active && 'op-45']"
      :data-active="person.active ? 'true' : 'false'"
      :style="{ zIndex: shown.length - index, marginInlineStart: index ? `-${overlap}px` : undefined }"
    />
    <span
      v-if="hidden.length"
      class="relative inline-flex items-center justify-center rounded-full bg-ui-avatar font-semibold text-ui-avatar-text ring-2"
      :class="ring"
      :title="t('agent.presenceMore', { count: hidden.length })"
      :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(8, Math.round(size * 0.38))}px`, marginInlineStart: `-${overlap}px`, zIndex: 0 }"
    >+{{ hidden.length }}</span>
  </span>
</template>
