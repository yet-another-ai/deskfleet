import { readFileSync } from "node:fs"
import { app } from "electron"
import { expect, test, vi } from "vitest"

const { menu, setApplicationMenu, setAboutPanelOptions } = vi.hoisted(() => ({
  menu: { items: [
    { label: "deskfleet", role: "appmenu", submenu: {
      items: [
        { label: "About deskfleet", role: "about" },
        { label: "Hide deskfleet", role: "hide", accelerator: "Command+H" },
        { label: "Hide Others", role: "hideothers" },
        { label: "Quit deskfleet", role: "quit", accelerator: "Command+Q" },
      ],
      insert(index: number, item: never) { this.items.splice(index, 0, item) },
    } },
  ] },
  setApplicationMenu: vi.fn(), setAboutPanelOptions: vi.fn(),
}))
vi.mock("electron", () => ({
  app: { name: "deskfleet", setAboutPanelOptions },
  Menu: { getApplicationMenu: () => menu, setApplicationMenu },
  MenuItem: class { constructor(options: object) { Object.assign(this, options) } },
}))
import { configureApplicationDisplay } from "./application-display.ts"

test("native display overrides add Preferences and preserve the menu's existing roles and shortcuts", () => {
  const openPreferences = vi.fn()
  configureApplicationDisplay(openPreferences)
  expect(setAboutPanelOptions).toHaveBeenCalledWith({ applicationName: "DeskFleet", iconPath: expect.stringMatching(/build[/\\]icon\.png$/u) })
  expect(menu.items[0]).toEqual({ label: "DeskFleet", role: "appmenu", submenu: expect.objectContaining({ items: [
    { label: "About DeskFleet", role: "about" },
    { type: "separator" },
    { label: "Preferences…", accelerator: "CommandOrControl+,", click: openPreferences },
    { label: "Hide DeskFleet", role: "hide", accelerator: "Command+H" },
    { label: "Hide Others", role: "hideothers" },
    { label: "Quit DeskFleet", role: "quit", accelerator: "Command+Q" },
  ] }) })
  expect(setApplicationMenu).toHaveBeenCalledWith(menu)
})

test("packaging display name stays separate from the existing secure-storage identity", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  const packaging = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8")
  expect(manifest.productName).toBe("deskfleet")
  expect(packaging).toMatch(/^productName: DeskFleet$/mu)
  expect(packaging).toContain('artifactName: "deskfleet-${version}-${os}-${arch}.${ext}"')
  const variant = readFileSync(new URL("../../electron-builder.super-agent.yml", import.meta.url), "utf8")
  expect(variant).toMatch(/^productName: DeskFleet SA$/mu)
  expect(variant).toMatch(/^  productName: DeskFleet Workspace Agent$/mu)
})

test("the SA variant presents its new name in the native menus while keeping its runtime name", () => {
  const original = app.name
  try {
    app.name = "DeskFleet Workspace Agent"
    menu.items[0]!.label = app.name
    configureApplicationDisplay()
    expect(menu.items[0]?.label).toBe("DeskFleet SA")
    expect(setAboutPanelOptions).toHaveBeenCalledWith(expect.objectContaining({ applicationName: "DeskFleet SA" }))
    expect(app.name).toBe("DeskFleet Workspace Agent")
  } finally {
    app.name = original
  }
})
