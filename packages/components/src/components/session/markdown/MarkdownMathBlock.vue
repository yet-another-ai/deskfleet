<script setup lang="ts">
import { Check, Copy } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
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
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="rendered.ok" v-html="rendered.html" />
    <pre v-else class="ui-math-fallback"><code>{{ `$$\n${trimmed}\n$$` }}</code></pre>
  </div>
</template>
