<script setup lang="ts">
import type { ThemedToken } from "shiki/core"

defineProps<{ tokens: readonly ThemedToken[] }>()
</script>

<template>
  <span><template v-for="(token, index) in tokens" :key="index"><br v-if="token.content === '\n'"><span v-else :style="token.htmlStyle">{{ token.content }}</span></template></span>
</template>
