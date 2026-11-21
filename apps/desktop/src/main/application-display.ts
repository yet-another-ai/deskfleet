import { app, Menu, MenuItem } from "electron"
import { buildResourcePath } from "./paths.ts"

export function desktopDisplayName(): string {
  return app.name === "DeskFleet Workspace Agent" ? "DeskFleet SA" : "DeskFleet"
}

function updateMenuLabels(menu: Menu, displayName: string): void {
  for (const item of menu.items) {
    if (item.label) item.label = item.label.replace(/\bdeskfleet(?: workspace agent| sa)?\b/gi, displayName)
    if (item.submenu) updateMenuLabels(item.submenu, displayName)
  }
}

/** Override native display labels without changing Electron's storage identity. */
export function configureApplicationDisplay(openPreferences?: () => void): void {
  const displayName = desktopDisplayName()
  app.setAboutPanelOptions({ applicationName: displayName, iconPath: buildResourcePath("icon.png") })
  // Electron installs its default role menu before the ready event.
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  updateMenuLabels(menu, displayName)
  const appMenu = menu.items.find(item => item.role?.toLowerCase() === "appmenu")?.submenu
  if (appMenu && openPreferences) {
    appMenu.insert(1, new MenuItem({ type: "separator" }))
    appMenu.insert(2, new MenuItem({ label: "Preferences…", accelerator: "CommandOrControl+,", click: openPreferences }))
  }
  Menu.setApplicationMenu(menu)
}
