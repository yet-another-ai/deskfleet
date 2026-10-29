interface QuitEvent {
  preventDefault(): void
}

interface BackgroundApplication {
  on(event: "before-quit", listener: (event: QuitEvent) => void): unknown
  on(event: "window-all-closed", listener: () => void): unknown
  quit(): void
}

export interface BackgroundLifecycle {
  /** Whether a real quit is in progress, so windows may close instead of hiding. */
  readonly quitting: boolean
  /** Ends the client process. Only the tray menu, the OS session, and signals call it. */
  quit(): void
  /** Let the updater close windows and quit after hosted services have stopped. */
  setInstallingUpdate(installing: boolean): void
}

/**
 * Keeps the client resident in the tray. Closing windows and ordinary quit
 * requests, such as Cmd+Q or the Dock menu, hide the client; it exits only
 * through `quit()`.
 */
export function keepRunningInBackground(
  application: BackgroundApplication,
  hideWindows: () => void,
): BackgroundLifecycle {
  let quitting = false
  let installingUpdate = false

  // Without a listener, Electron quits once the last window closes.
  application.on("window-all-closed", () => {})
  application.on("before-quit", (event) => {
    if (quitting || installingUpdate) return
    event.preventDefault()
    hideWindows()
  })

  return {
    get quitting() {
      return quitting || installingUpdate
    },
    quit() {
      quitting = true
      application.quit()
    },
    setInstallingUpdate(installing) {
      installingUpdate = installing
    },
  }
}
