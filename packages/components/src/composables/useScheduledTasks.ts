import { useIntervalFn } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { schedulesClient, type ScheduleInput, type ScheduleRun, type ScheduledTask } from "@deskfleet/client/schedules"
import { useFleetStore } from "../stores/fleet.ts"
import { useAccountSession } from "./useAccountSession.ts"

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

/**
 * The selected machine's scheduled tasks and the actions that change them. One mutation runs
 * at a time; a list response that started before it never replaces its result.
 */
export function useScheduledTasks() {
  const { t } = useI18n()
  const account = useAccountSession()
  const fleet = useFleetStore()
  const api = account && schedulesClient(account.central, fleet.targetId)
  const online = computed(() => !!api && (account?.machine.value?.online ?? fleet.localDesktopTarget.online))
  const tasks = ref<ScheduledTask[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const pending = ref(false)
  const error = ref<string>()
  let revision = 0
  let disposed = false

  async function refresh(): Promise<void> {
    const request = ++revision
    if (!online.value || !api) { loading.value = false; return }
    loading.value = true
    try {
      const result = await api.list()
      if (disposed || request !== revision) return
      tasks.value = result
      loaded.value = true
      error.value = undefined
    } catch (reason) {
      if (!disposed && request === revision) error.value = message(reason)
    } finally { if (!disposed && request === revision) loading.value = false }
  }
  function replace(task: ScheduledTask): void {
    const index = tasks.value.findIndex(value => value.id === task.id)
    if (index < 0) tasks.value.unshift(task)
    else tasks.value[index] = task
  }
  async function mutate<T>(work: () => Promise<T>): Promise<T> {
    if (!api || !online.value) throw new Error(t("schedules.offline"))
    if (pending.value) throw new Error(t("schedules.busy"))
    ++revision
    loading.value = false
    pending.value = true
    error.value = undefined
    try { return await work() }
    finally { if (!disposed) pending.value = false }
  }
  /** Row and header actions report failure on the page; forms and dialogs show their own. */
  async function action(work: () => Promise<unknown>): Promise<boolean> {
    try { await mutate(work); return true }
    catch (reason) { if (!disposed) error.value = message(reason); return false }
  }

  async function save(id: string | undefined, input: ScheduleInput): Promise<ScheduledTask> {
    return mutate(async () => {
      const task = id ? await api!.update(id, input) : await api!.create(input)
      if (!disposed) replace(task)
      return task
    })
  }
  async function toggle(task: ScheduledTask): Promise<void> {
    await action(async () => {
      const updated = await api!.update(task.id, { enabled: !task.enabled })
      if (!disposed) replace(updated)
    })
  }
  async function run(task: ScheduledTask): Promise<void> {
    const accepted = await action(async () => {
      const result: ScheduleRun = await api!.run(task.id)
      if (!disposed) replace({ ...task, lastRun: result, runs: [result, ...task.runs.filter(run => run.id !== result.id)].slice(0, 50) })
    })
    if (accepted && !disposed) await refresh()
  }
  async function remove(task: ScheduledTask): Promise<void> {
    await mutate(async () => {
      await api!.remove(task.id)
      if (!disposed) tasks.value = tasks.value.filter(value => value.id !== task.id)
    })
  }

  watch(online, () => { void refresh() }, { immediate: true })
  const unsubscribe = account?.central.onEvent(event => {
    if (event.type === "catalogChanged" && event.machineId === fleet.targetId && !pending.value) void refresh()
  })
  // The visible page follows execution status; switching routes or hiding the window stops reads.
  useIntervalFn(() => { if (!document.hidden && !loading.value && !pending.value) void refresh() }, 15_000)
  onBeforeUnmount(() => { disposed = true; revision++; unsubscribe?.() })

  return { account, available: !!api, online, tasks, loaded, loading, pending, error, refresh, save, toggle, run, remove }
}
