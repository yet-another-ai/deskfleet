<script setup lang="ts">
import { computed } from "vue"
import { isFileResource } from "../../../services/agent-resources.ts"

const props = defineProps<{
  node: { href?: unknown; text?: unknown; title?: string | null }
}>()

const href = computed(() => String(props.node.href ?? ""))
const text = computed(() => String(props.node.text ?? ""))
const isResource = computed(() => isFileResource(href.value))
const isExternalHttp = computed(() => /^https?:/iu.test(href.value))
</script>

<template>
  <a
    v-if="isResource"
    href="#"
    :data-resource-link="href"
    :title="node.title || undefined"
  >{{ text }}</a>
  <a
    v-else
    :href="href"
    :target="isExternalHttp ? '_blank' : undefined"
    :rel="isExternalHttp ? 'noopener noreferrer' : undefined"
    :title="node.title || undefined"
  >{{ text }}</a>
</template>
