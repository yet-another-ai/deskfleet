import { Menu, nativeImage, Tray } from "electron"
import { t } from "./i18n.ts"
import { buildResourcePath } from "./paths.ts"

interface TrayActions {
  show(): void
  quit(): void
}

// A collected Tray disappears from the notification area, so keep a reference.
let tray: Tray | null = null
let trayActions: TrayActions | null = null

export function createTray(actions: TrayActions): void {
  trayActions = actions
  // The "Template" suffix lets macOS tint the image for the menu bar appearance.
  const image = process.platform === "darwin" ? "trayTemplate.png" : "tray.png"
  tray = new Tray(nativeImage.createFromPath(buildResourcePath(image)))
  tray.setToolTip("deskfleet")
  refreshTrayMenu()
  // Windows tray icons open their app on click and show the menu on right-click.
  if (process.platform === "win32") tray.on("click", actions.show)
}

export function refreshTrayMenu(): void {
  if (!tray || !trayActions) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("tray.show"), click: trayActions.show },
      { type: "separator" },
      { label: t("tray.quit"), click: trayActions.quit },
    ]),
  )
}
