<script setup lang="ts">
import { Check, Copy } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import UiScrollArea from "../../common/UiScrollArea.vue"
import { renderCachedMath } from "./context.ts"

const props = defineProps<{
  node?: { content?: unknown }
  content?: string
}>()

const { t } = useI18n()

const trimmed = computed(() => String(props.content ?? props.node?.content ?? "").trim())
const rendered = computed(() => renderCachedMath(trimmed.value, true))
const copyLabel = computed(() => t("common.copy"))
</script>

<template>
  <div class="ui-math-block" data-math-block="">
    <button
      type="button"
      class="ui-button-ghost ui-math-copy h-7 w-7 shrink-0 p-0"
      :data-math-copy="trimmed"
      :aria-label="copyLabel"
      :title="copyLabel"
    >
      <Copy :size="14" data-icon-copy="" aria-hidden="true" />
      <Check :size="14" data-icon-check="" aria-hidden="true" />
    </button>
    <UiScrollArea orientation="horizontal" fade-size="sm" viewport-class="py-2.5 pr-10 pl-3.5">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="rendered.ok" v-html="rendered.html" />
      <pre v-else class="ui-math-fallback !m-0 !border-0 !bg-transparent !p-0"><code>{{ `$$\n${trimmed}\n$$` }}</code></pre>
    </UiScrollArea>
  </div>
</template>
