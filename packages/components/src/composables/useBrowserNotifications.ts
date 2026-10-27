import { onBeforeUnmount, onMounted } from "vue"
import { useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { BrowserNotifications, getBrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import { TaskNotificationMonitor } from "@deskfleet/client/task-notification-monitor"

/** The Web page observes all authorized machines, independently of the selected route. */
export function useBrowserNotifications(host: DeskfleetDesktopApi): void {
  const { t } = useI18n()
  const central = host.central
  if (host.platform !== "web" || !central || getBrowserNotificationPermission() === "unsupported") return
  let stop: (() => void) | undefined

  function start(): void {
    if (stop || !central) return
    const notifications = new BrowserNotifications(host.settings, kind => t(`notification.${kind}`))
    const monitor = new TaskNotificationMonitor(central, event => { void notifications.notify(event) }, console.error)
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

  onMounted(start)
  useEventListener(window, "pagehide", () => stop?.())
  useEventListener(window, "pageshow", start)
  onBeforeUnmount(() => stop?.())
}
