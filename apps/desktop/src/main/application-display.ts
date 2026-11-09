import { app, Menu, MenuItem } from "electron"
import { buildResourcePath } from "./paths.ts"

function updateMenuLabels(menu: Menu): void {
  for (const item of menu.items) {
    if (item.label) item.label = item.label.replaceAll("deskfleet", "DeskFleet")
    if (item.submenu) updateMenuLabels(item.submenu)
  }
}

/** Override native display labels without changing Electron's storage identity. */
export function configureApplicationDisplay(openPreferences?: () => void): void {
  app.setAboutPanelOptions({ applicationName: "DeskFleet", iconPath: buildResourcePath("icon.png") })
  // Electron installs its default role menu before the ready event.
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  updateMenuLabels(menu)
  const appMenu = menu.items.find(item => item.role?.toLowerCase() === "appmenu")?.submenu
  if (appMenu && openPreferences) {
    appMenu.insert(1, new MenuItem({ type: "separator" }))
    appMenu.insert(2, new MenuItem({ label: "Preferences…", accelerator: "CommandOrControl+,", click: openPreferences }))
  }
  Menu.setApplicationMenu(menu)
}
