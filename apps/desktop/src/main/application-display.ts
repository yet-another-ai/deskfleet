import { app, Menu } from "electron"
import { buildResourcePath } from "./paths.ts"

function updateMenuLabels(menu: Menu): void {
  for (const item of menu.items) {
    item.label = item.label.replaceAll("deskfleet", "DeskFleet")
    if (item.submenu) updateMenuLabels(item.submenu)
  }
}

/** Override native display labels without changing Electron's storage identity. */
export function configureApplicationDisplay(): void {
  app.setAboutPanelOptions({ applicationName: "DeskFleet", iconPath: buildResourcePath("icon.png") })
  // Electron installs its default role menu before the ready event.
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  updateMenuLabels(menu)
  Menu.setApplicationMenu(menu)
}
