<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { isValidAccentSlot } from "@deskfleet/protocol/super-agent"
import "../../styles/sa-ticket-accents.css"

const props = defineProps<{
  replyTo: string
  text: string
  locatable: boolean
  accentSlot?: number
  touch?: boolean
}>()
const emit = defineEmits<{ locate: [id: string] }>()
const { t } = useI18n()
const validAccentSlot = computed(() => isValidAccentSlot(props.accentSlot) ? props.accentSlot : undefined)
</script>

<template>
  <blockquote
    :data-reply-quote="replyTo"
    :data-reply-quote-state="locatable ? 'available' : 'unavailable'"
    :data-sa-quote-rail="validAccentSlot !== undefined ? 'true' : undefined"
    :data-sa-accent-slot="validAccentSlot"
    class="m-0 mb-1 max-w-full truncate border-l-2 text-xs text-ui-text-muted"
    :class="[
      !locatable && 'pl-2',
      validAccentSlot !== undefined
        ? 'sa-ticket-accent sa-ticket-rail'
        : locatable
          ? 'border-ui-accent'
          : 'border-ui-border',
    ]"
  >
    <button
      v-if="locatable"
      type="button"
      data-reply-quote-target
      :aria-label="t('superAgent.locateQuotedMessage', { text })"
      :class="touch && 'min-h-11 py-2'"
      class="flex min-w-0 max-w-full cursor-pointer items-center pl-2 text-left ui-motion hover:text-ui-text"
      @click="emit('locate', replyTo)"
    >
      <span class="min-w-0 truncate">{{ text }}</span>
    </button>
    <template v-else>{{ text }}</template>
  </blockquote>
</template>
