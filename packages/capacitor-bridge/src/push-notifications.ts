import type { PermissionState, PluginListenerHandle } from "@capacitor/core"
import { PushNotifications, type ActionPerformed, type RegistrationError, type Token } from "@capacitor/push-notifications"
import type { BrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import type { CentralApi, PushChannel } from "@deskfleet/client/central"
import type { NotificationSettings, SettingsApi } from "@deskfleet/client/settings"

export const ANDROID_TASK_NOTIFICATION_CHANNEL_ID = "deskfleet_tasks"

export interface PushNotificationTarget {
  teamId: string
  machineId: string
  sessionId: string
}

export interface CapacitorPushNotificationsOptions {
  platform: "ios" | "android"
  central: Pick<CentralApi, "status" | "savePushSubscription" | "removePushSubscription" | "onEvent">
  settings: Pick<SettingsApi, "getNotifications" | "setNotifications">
  locale: string | (() => string)
  enabled?: () => boolean
  onError?: (error: unknown) => void
}

export function mapCapacitorPushPermission(state: PermissionState): BrowserNotificationPermission {
  if (state === "granted" || state === "denied") return state
  return "default"
}

export function parseNotificationTarget(data: unknown): PushNotificationTarget | undefined {
  if (!data || typeof data !== "object") return undefined
  const record = data as Record<string, unknown>
  const teamId = typeof record.teamId === "string" ? record.teamId.trim() : ""
  const machineId = typeof record.machineId === "string" ? record.machineId.trim() : ""
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : ""
  return teamId && machineId && sessionId ? { teamId, machineId, sessionId } : undefined
}

export function createCapacitorPushNotifications(options: CapacitorPushNotificationsOptions) {
  const channel: PushChannel = options.platform === "ios" ? "apns" : "fcm"
  const isEnabled = options.enabled ?? (() => true)
  const onError = options.onError ?? (error => console.error("Mobile push notification sync failed", error))
  const openListeners = new Set<(target: PushNotificationTarget) => void>()
  let pendingTarget: PushNotificationTarget | undefined
  let currentToken: string | undefined
  let channelCreated = options.platform !== "android"
  let closed = false

  async function registerDevice(): Promise<void> {
    if (closed || !isEnabled()) return
    if (!channelCreated) {
      channelCreated = true
      await PushNotifications.createChannel({
        id: ANDROID_TASK_NOTIFICATION_CHANNEL_ID,
        name: "Task notifications",
        description: "Agent task completion and input requests",
        importance: 4,
      }).catch(() => {})
    }
    await PushNotifications.register()
  }

  async function syncSubscription(): Promise<void> {
    const token = currentToken
    if (closed || !isEnabled() || !token || !options.central.savePushSubscription) return
    const [account, settings] = await Promise.all([options.central.status(), options.settings.getNotifications()])
    if (closed || !isEnabled() || !account.user || currentToken !== token) return
    const locale = typeof options.locale === "function" ? options.locale() : options.locale
    await options.central.savePushSubscription({ channel, token, locale, settings })
  }

  async function getNotificationPermission(): Promise<BrowserNotificationPermission> {
    if (!isEnabled()) return "unsupported"
    try {
      const permission = mapCapacitorPushPermission((await PushNotifications.checkPermissions()).receive)
      if (permission === "granted" && isEnabled()) void registerDevice().catch(onError)
      return permission
    } catch {
      return "unsupported"
    }
  }

  async function requestNotificationPermission(): Promise<BrowserNotificationPermission> {
    if (!isEnabled()) return "unsupported"
    const permission = mapCapacitorPushPermission((await PushNotifications.requestPermissions()).receive)
    if (permission === "granted" && isEnabled()) await registerDevice()
    return permission
  }

  async function sync(): Promise<void> {
    if (!closed && isEnabled() && (await getNotificationPermission()) === "granted" && currentToken) {
      await syncSubscription()
    }
  }

  const listenerPromises: Promise<PluginListenerHandle>[] = [
    PushNotifications.addListener("registration", (token: Token) => {
      const trimmed = token.value.trim()
      if (closed || !trimmed) return
      currentToken = trimmed
      void syncSubscription().catch(onError)
    }),
    PushNotifications.addListener("registrationError", (error: RegistrationError) => {
      if (!closed && isEnabled()) onError(new Error(error.error))
    }),
    PushNotifications.addListener("pushNotificationActionPerformed", (action: ActionPerformed) => {
      const target = !closed ? parseNotificationTarget(action.notification?.data) : undefined
      if (!target) return
      if (openListeners.size === 0) pendingTarget = target
      else for (const listener of openListeners) listener(target)
    }),
  ]

  const unsubscribeCentral = options.central.onEvent(event => {
    if (!closed && (event.type === "accountChanged" || (event.type === "connection" && event.connected))) {
      void sync().catch(onError)
    }
  })

  void sync().catch(onError)

  return {
    settings: {
      getNotifications: () => options.settings.getNotifications(),
      async setNotifications(next: NotificationSettings): Promise<NotificationSettings> {
        const saved = await options.settings.setNotifications(next)
        void syncSubscription().catch(onError)
        return saved
      },
      getNotificationPermission,
      requestNotificationPermission,
    },
    sync,
    onOpenSession(listener: (target: PushNotificationTarget) => void): () => void {
      openListeners.add(listener)
      if (pendingTarget) {
        const target = pendingTarget
        pendingTarget = undefined
        listener(target)
      }
      return () => openListeners.delete(listener)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      unsubscribeCentral()
      openListeners.clear()
      await Promise.all(listenerPromises.map(p => p.then(h => h.remove()).catch(() => {})))
    },
  }
}

export type CapacitorPushNotifications = ReturnType<typeof createCapacitorPushNotifications>
