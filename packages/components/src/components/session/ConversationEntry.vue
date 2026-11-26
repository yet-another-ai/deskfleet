<script setup lang="ts">
import { computed, provide } from "vue"
import { conversationEntryIdKey } from "../../services/preview.ts"

const props = defineProps<{ id?: string }>()
provide(conversationEntryIdKey, computed(() => props.id))
</script>

<template>
  <div :data-conversation-entry="id">
    <slot />
  </div>
</template>
