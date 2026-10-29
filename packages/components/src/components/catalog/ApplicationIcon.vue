<script setup lang="ts">
import { CodeXml, FolderOpen, SquareTerminal } from "@lucide/vue"
import { computed } from "vue"
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?url"
import vscode from "../../assets/editors/vscode.svg?url"
import vscodium from "../../assets/editors/vscodium.svg?url"
import zed from "../../assets/editors/zed.svg?url"
import type { LocalApplication } from "../../../../client/src/applications.ts"

const props = defineProps<{ application: LocalApplication }>()
const editorIcons: Record<string, string> = { vscode, vscodium }
const icon = computed(() => editorIcons[props.application.id])
const cursorStyle = { maskImage: `url("${cursor}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center" }
const zedStyle = { ...cursorStyle, maskImage: `url("${zed}")` }
</script>

<template>
  <img v-if="icon" :src="icon" alt="" class="h-4 w-4 shrink-0 object-contain" aria-hidden="true" />
  <span v-else-if="application.id === 'cursor'" class="inline-block h-4 w-4 shrink-0 bg-current" :style="cursorStyle" aria-hidden="true" />
  <span v-else-if="application.id === 'zed'" class="inline-block h-4 w-4 shrink-0 bg-current" :style="zedStyle" aria-hidden="true" />
  <SquareTerminal v-else-if="application.kind === 'terminal'" :size="16" class="shrink-0" aria-hidden="true" />
  <FolderOpen v-else-if="application.kind === 'fileManager'" :size="16" class="shrink-0" aria-hidden="true" />
  <CodeXml v-else :size="16" class="shrink-0" aria-hidden="true" />
</template>
