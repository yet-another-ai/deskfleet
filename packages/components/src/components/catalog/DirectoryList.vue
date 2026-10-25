<script setup lang="ts">
import { SquareTerminal } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import type { DirectoryBinding } from "../../stores/fleet-types.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"

/** With an `owner`, shells belong to that Session and open in its terminal panel. */
const props = defineProps<{ directories: DirectoryBinding[]; disabled?: boolean; defaultAction?: boolean; owner?: { sessionId: string; worktreeId: string } }>()
const layout = useLayoutStore()
const { t } = useI18n()
const router = useRouter()
const terminals = useTerminalsStore()
const launching = ref(false)
const error = ref<string | null>(null)
async function open(cwd?: string): Promise<void> {
  if (!cwd || props.disabled || launching.value) return
  error.value = null
  launching.value = true
  try {
    // The cwd only chooses a startup directory; the owner decides the terminal's scope.
    const terminal = await terminals.create({ cwd, worktreeId: props.owner?.worktreeId })
    if (props.owner) {
      layout.terminalPanelOpen = true
      await router.push({ name: "session", params: { sessionId: props.owner.sessionId } })
    } else await router.push({ name: "terminal", params: { terminalId: terminal.id } })
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { launching.value = false }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="defaultAction">
      <button type="button" class="ui-button" :disabled="disabled || launching || directories.length === 0" @click="open(directories[0]?.path)">
        <SquareTerminal :size="15" aria-hidden="true" />{{ t("workspace.openDefaultTerminal") }}
      </button>
    </div>
    <ul class="ui-card">
      <li v-for="(directory, index) in directories" :key="index" class="ui-card-row gap-3">
        <div class="min-w-0 flex-1">
          <span v-if="index === 0" class="ui-badge mb-1 inline-block">{{ t("catalog.defaultDirectory") }}</span>
          <div class="break-all font-mono text-xs text-ui-text-muted select-text">{{ directory.path }}</div>
          <div v-if="directory.git" class="font-mono text-xs text-ui-text-faint">{{ directory.git.branch }}</div>
          <div v-else-if="directory.git === null" class="text-xs text-ui-text-faint">{{ t("panel.notGit") }}</div>
        </div>
        <button type="button" class="ui-button shrink-0" :disabled="disabled || launching" :aria-label="t('worktree.openTerminalAt', { path: directory.path })" @click="open(directory.path)">
          <SquareTerminal :size="15" aria-hidden="true" />{{ t("worktree.openTerminal") }}
        </button>
      </li>
    </ul>
    <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
  </div>
</template>
