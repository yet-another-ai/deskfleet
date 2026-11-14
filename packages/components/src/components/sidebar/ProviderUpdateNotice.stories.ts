import type { CentralEvent, Machine } from "@deskfleet/client/central"
import type { ProviderTemplateUpdates, ProviderUpdate } from "@deskfleet/client/providers"
import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { onScopeDispose, provide, ref } from "vue"
import type { AgentProviderTemplateId } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { accountSessionKey, useAccountSession } from "../../composables/useAccountSession.ts"
import ProviderUpdateNotice from "./ProviderUpdateNotice.vue"

const meta = {
  title: "Navigation/Provider updates",
  args: { status: "available" as ProviderUpdate["status"] },
  render: args => ({
    components: { ProviderUpdateNotice },
    setup() {
      const account = useAccountSession()!
      const teamId = "updates-team"
      const listeners = new Set<(event: CentralEvent) => void>()
      const timers = new Set<ReturnType<typeof setTimeout>>()
      onScopeDispose(() => timers.forEach(clearTimeout))
      const machines = ref<Machine[]>([
        { id: "updates-mac", teamId, name: "MacBook Pro", originId: "mac", localMachineId: "1", online: true, capabilities: {}, lastSeenAt: "2026-11-13T09:00:00Z" },
        { id: "updates-win", teamId, name: "Windows workstation", originId: "win", localMachineId: "1", online: true, capabilities: {}, lastSeenAt: "2026-11-13T09:00:00Z" },
        { id: "updates-home", teamId, name: "Home server", originId: "home", localMachineId: "1", online: false, capabilities: {}, lastSeenAt: "2026-11-12T09:00:00Z" },
      ])
      const codex: ProviderUpdate = { currentVersion: "0.165.1", latestVersion: "0.167.2", status: "available" }
      const updates: Record<string, ProviderTemplateUpdates> = {
        "updates-mac": {
          codex: { ...codex, status: args.status, ...(args.status === "error" ? { error: "The installer could not download the update. Please retry." } : {}) },
          "claude-code": { currentVersion: "2.1.190", latestVersion: "2.1.200", status: "available" },
        },
        "updates-win": {
          codex: { ...codex },
          cursor: { currentVersion: "2026.11.09-aaaaaaa", latestVersion: "2026.11.11-b912975", status: "available" },
        },
        "updates-home": { codex: { ...codex } },
      }
      const changed = (machineId: string) => {
        for (const listener of listeners) listener({ type: "catalogChanged", teamId, machineId })
      }
      provide(accountSessionKey, {
        ...account,
        teamId: ref(teamId),
        machines,
        central: {
          ...account.central,
          catalog: async (_teamId, machineId) => ({
            machineId,
            snapshot: { teamId, machineId, machineName: machineId, sessionIds: [], sessions: [], workspaces: [] },
            lastObservedAt: "2026-11-13T09:00:00Z",
            providers: { providers: [], updates: structuredClone(updates[machineId] ?? {}) },
          }),
          onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
          async rpc<T = unknown>(_teamId: string, machineId: string, _method: string, params: unknown): Promise<T> {
            const { template } = params as { template: AgentProviderTemplateId }
            const update = updates[machineId]?.[template]
            if (update) {
              updates[machineId]![template] = { ...update, status: "updating" }
              changed(machineId)
              const timer = setTimeout(() => {
                timers.delete(timer)
                delete updates[machineId]![template]
                changed(machineId)
              }, 2_000)
              timers.add(timer)
            }
            return null as T
          },
        },
      })
    },
    template: `<aside class="w-[260px] border border-ui-border bg-ui-sidebar pt-2"><ProviderUpdateNotice /></aside>`,
  }),
} satisfies Meta<{ status: ProviderUpdate["status"] }>
export default meta
type Story = StoryObj<typeof meta>

export const MultipleToolsAndMachines: Story = {}
export const Updating: Story = { args: { status: "updating" } }
export const Failed: Story = { args: { status: "error" } }
