<script lang="ts">
import SpringSurface from "../common/SpringSurface.ts"
import { Folder, FolderOpen, GitBranch, Laptop } from "@lucide/vue"
import { useMediaQuery } from "@vueuse/core"
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"
import { computed, defineComponent, ref, shallowRef, watch, type PropType } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { extractSessionPreview, type SessionMessagePreview } from "../../services/session-preview.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"

const gitCheckoutCache = new Map<string, { branch: string | null; head: string | null } | null>()

// Preserve VNodes while integrating with Reka UI's tooltip primitives under Vue Vapor.
export default defineComponent({
  name: "SessionHoverTooltip",
  components: { Folder, FolderOpen, GitBranch, Laptop, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger },
  props: {
    machineId: String,
    sessionId: { type: String, required: true },
    title: { type: String, required: true },
    machineName: { type: String, required: true },
    online: { type: Boolean, default: true },
    context: String as PropType<"directory" | "worktree">,
  },
  setup(props) {
    const { t } = useI18n()
    const account = useAccountSession()
    const runtimes = useMachineRuntimes()
    const hostAgents = useAgentSessionsStore()
    const hostFleet = useFleetStore()
    const noHover = useMediaQuery("(hover: none)")
    const open = ref(false)
    const loading = ref(false)
    const fetched = shallowRef<SessionMessagePreview | null>(null)
    const checkoutKey = computed(() => `${props.machineId ?? hostFleet.targetId}:${props.sessionId}`)
    const checkout = shallowRef(gitCheckoutCache.get(checkoutKey.value))

    const targetState = computed(() => props.machineId ? runtimes?.opened.get(props.machineId)?.state : undefined)
    const targetAgents = computed(() => targetState.value
      ? useAgentSessionsStore(targetState.value)
      : (!props.machineId || !account || account.machineId.value === props.machineId || hostFleet.targetId === props.machineId ? hostAgents : undefined))
    const directoryName = computed(() => {
      const fleet = targetState.value ? useFleetStore(targetState.value) : hostFleet
      const machine = fleet.machines.find(m => m.id === (props.machineId ?? fleet.targetId))
      const workspace = machine?.workspaces.find(w => w.sessions.some(s => s.id === props.sessionId))
      const session = machine?.sessions.find(s => s.id === props.sessionId) ?? workspace?.sessions.find(s => s.id === props.sessionId)
      const path = props.context === "worktree" ? workspace?.directories[0]?.path : (session?.worktree?.directories[0]?.path ?? workspace?.directories[0]?.path)
      const trimmed = path?.replace(/[\\/]+$/u, "")
      return trimmed ? (trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed) : workspace?.name
    })
    const livePreview = computed(() => {
      const loaded = targetAgents.value?.views[props.sessionId]
      return loaded?.snapshot && (loaded.events.length > 0 || loaded.snapshot.inputs.length === 0) ? extractSessionPreview(loaded.snapshot, loaded.events) : null
    })
    const preview = computed(() => livePreview.value ?? fetched.value)
    const checkoutLabel = computed(() => checkout.value
      ? (checkout.value.branch ?? `${t("panel.detachedHead")}${checkout.value.head ? ` · ${checkout.value.head.slice(0, 8)}` : ""}`)
      : (props.context === "worktree" ? t("session.worktree") : undefined))

    watch(open, isOpen => {
      const agents = isOpen ? targetAgents.value : undefined
      if (!agents) return
      if (!livePreview.value) {
        loading.value = true
        void agents.readPreview(props.sessionId).then(r => { fetched.value = r }).catch(() => {}).finally(() => { loading.value = false })
      }
      if (props.online && checkout.value === undefined) {
        const key = checkoutKey.value
        void agents.gitStatus(props.sessionId).then(status => {
          const repo = status.repositories.find(item => !item.error)
          checkout.value = repo ? { branch: repo.branch, head: repo.head } : null
          gitCheckoutCache.set(key, checkout.value)
        }).catch(() => {})
      }
    })

    return { SpringSurface, FolderOpen, GitBranch, noHover, open, loading, preview, directoryName, checkoutLabel }
  },
})
</script>

<template>
  <TooltipProvider :delay-duration="250" :disabled="noHover">
    <TooltipRoot v-model:open="open">
      <TooltipTrigger as="div" class="w-full"><slot /></TooltipTrigger>
      <TooltipPortal>
        <TooltipContent :as="SpringSurface" side="right" :side-offset="8" :collision-padding="8" class="ui-tooltip z-70 max-w-72 break-words rounded-md border border-ui-border bg-ui-surface px-2.5 py-2 text-xs leading-5 text-ui-text shadow-ui-popover">
          <p class="m-0 truncate font-medium">{{ preview?.userMessage || title }}</p>
          <span v-if="loading && !preview" class="mt-1.5 block h-3 w-36 animate-pulse rounded bg-ui-border/50" aria-hidden="true" />
          <p v-else-if="preview?.assistantReply" class="m-0 mt-1 truncate text-ui-text-muted">{{ preview.assistantReply }}</p>
          <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-ui-border/60 pt-1.5 text-[11px] leading-4 text-ui-text-faint">
            <span class="inline-flex min-w-0 items-center gap-1 truncate"><Laptop :size="11" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ machineName }}</span></span>
            <span v-if="directoryName" class="inline-flex min-w-0 items-center gap-1 truncate"><Folder :size="11" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ directoryName }}</span></span>
            <span v-if="checkoutLabel" class="inline-flex min-w-0 items-center gap-1 truncate"><component :is="context === 'directory' ? FolderOpen : GitBranch" :size="11" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ checkoutLabel }}</span></span>
          </div>
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
