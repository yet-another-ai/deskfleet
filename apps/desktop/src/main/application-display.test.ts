import { readFileSync } from "node:fs"
import { expect, test, vi } from "vitest"

const { menu, setApplicationMenu, setAboutPanelOptions } = vi.hoisted(() => ({
  menu: { items: [
    { label: "deskfleet", role: "appmenu", submenu: { items: [
      { label: "About deskfleet", role: "about" },
      { label: "Hide deskfleet", role: "hide", accelerator: "Command+H" },
      { label: "Hide Others", role: "hideothers" },
      { label: "Quit deskfleet", role: "quit", accelerator: "Command+Q" },
    ] } },
  ] },
  setApplicationMenu: vi.fn(), setAboutPanelOptions: vi.fn(),
}))
vi.mock("electron", () => ({
  app: { setAboutPanelOptions },
  Menu: { getApplicationMenu: () => menu, setApplicationMenu },
}))
import { configureApplicationDisplay } from "./application-display.ts"

test("native display overrides preserve the menu's existing roles and shortcuts", () => {
  configureApplicationDisplay()
  expect(setAboutPanelOptions).toHaveBeenCalledWith({ applicationName: "DeskFleet", iconPath: expect.stringMatching(/build[/\\]icon\.png$/u) })
  expect(menu.items[0]).toEqual({ label: "DeskFleet", role: "appmenu", submenu: { items: [
    { label: "About DeskFleet", role: "about" },
    { label: "Hide DeskFleet", role: "hide", accelerator: "Command+H" },
    { label: "Hide Others", role: "hideothers" },
    { label: "Quit DeskFleet", role: "quit", accelerator: "Command+Q" },
  ] } })
  expect(setApplicationMenu).toHaveBeenCalledWith(menu)
})

test("packaging display name stays separate from the existing secure-storage identity", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  const packaging = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8")
  expect(manifest.productName).toBe("deskfleet")
  expect(packaging).toMatch(/^productName: DeskFleet$/mu)
  expect(packaging).toContain('artifactName: "deskfleet-${version}-${os}-${arch}.${ext}"')
})
