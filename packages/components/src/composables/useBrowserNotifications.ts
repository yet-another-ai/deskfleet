import { onBeforeUnmount, onMounted, watch } from "vue"
import { useEventListener, usePermission } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { BrowserNotifications, getBrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import { browserNotificationChanges, browserNotificationStorageKey } from "@deskfleet/client/browser-notification-settings"
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import { TaskNotificationMonitor } from "@deskfleet/client/task-notification-monitor"

/** The Web page observes all authorized machines, independently of the selected route. */
export function useBrowserNotifications(
  host: DeskfleetDesktopApi,
  onSelect?: (target: { teamId: string; machineId: string; sessionId: string }) => void,
): void {
  const { t } = useI18n()
  const central = host.central
  if (host.platform !== "web" || host.mobile || !central || getBrowserNotificationPermission() === "unsupported") return
  let stop: (() => void) | undefined
  let pageActive = false
  let revision = 0

  function start(): void {
    if (stop || !central) return
    const notifications = new BrowserNotifications(host.settings, kind => t(`notification.${kind}`), undefined, onSelect)
    const monitor = new TaskNotificationMonitor(withCentralRequestTrigger(central, "background"), event => { void notifications.notify(event) }, console.error)
    const unsubscribe = central.onEvent(event => {
      if (event.type === "accountChanged") notifications.clear()
    })
    stop = () => {
      monitor.close()
      notifications.close()
      unsubscribe()
      stop = undefined
    }
    void monitor.start().catch(console.error)
  }

  async function reconcile(): Promise<void> {
    const current = ++revision
    if (!pageActive || getBrowserNotificationPermission() !== "granted") {
      stop?.()
      return
    }
    try {
      const settings = await host.settings.getNotifications()
      if (current !== revision) return
      if (getBrowserNotificationPermission() === "granted" && settings.enabled && (settings.taskCompleted || settings.taskNeedsInput)) start()
      else stop?.()
    } catch (error) {
      if (current !== revision) return
      stop?.()
      console.error("Could not read browser notification preferences", error)
    }
  }
  function resume(): void { pageActive = true; void reconcile() }
  function suspend(): void { pageActive = false; void reconcile() }

  watch(usePermission("notifications"), reconcile)
  useEventListener(browserNotificationChanges, "change", reconcile)
  useEventListener(window, "storage", event => {
    if (event.key === browserNotificationStorageKey || event.key === null) void reconcile()
  })
  useEventListener(window, "focus", reconcile)
  useEventListener(window, "pagehide", suspend)
  useEventListener(window, "pageshow", resume)
  onMounted(resume)
  onBeforeUnmount(suspend)
}
