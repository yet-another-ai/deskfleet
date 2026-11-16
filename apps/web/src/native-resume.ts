import type { PluginListenerHandle } from "@capacitor/core"
import { dispatchAppForeground } from "@deskfleet/client/app-foreground"

/**
 * A switch back from another process suspends the WebView without
 * `visibilitychange` or `pageshow`. Peer and signaling recovery listen for
 * the foreground event instead.
 */
export function listenForNativeResume(
  addListener: (eventName: "resume", listenerFunc: () => void) => Promise<PluginListenerHandle>,
): Promise<PluginListenerHandle> {
  return addListener("resume", dispatchAppForeground)
}
