import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { LinuxLaunchAtStartup } from "./linux-launch-at-startup.ts"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture(executable = "/opt/Desk Fleet/deskfleet-0.3.2.AppImage") {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-autostart-"))
  directories.push(directory)
  const path = join(directory, "autostart", "io.github.yet_another_ai.deskfleet.desktop")
  return {
    path,
    controller: new LinuxLaunchAtStartup(path, executable),
    read: () => readFileSync(path, "utf8"),
    write(contents: string) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, contents)
    },
  }
}

test("enabling creates a desktop entry and disabling removes it across restarts", () => {
  const f = fixture()
  expect(f.controller.get()).toBe(false)
  expect(f.controller.set(false)).toBe(false)
  expect(existsSync(dirname(f.path))).toBe(false)

  expect(f.controller.set(true)).toBe(true)
  expect(f.read().split("\n")).toEqual(expect.arrayContaining([
    "[Desktop Entry]", "Type=Application", "Name=DeskFleet",
    'Exec="/opt/Desk Fleet/deskfleet-0.3.2.AppImage"', "Terminal=false",
  ]))
  const restarted = new LinuxLaunchAtStartup(f.path, "/opt/Desk Fleet/deskfleet-0.3.2.AppImage")
  expect(restarted.get()).toBe(true)
  expect(restarted.set(false)).toBe(false)
  expect(existsSync(f.path)).toBe(false)
  expect(restarted.set(false)).toBe(false)
})

test.each(["100%", "100%=version"])("Exec quotes paths including %s using desktop entry rules", (name) => {
  const f = fixture(`/opt/Desk Fleet/"quoted"/back\\slash/$cash/\`tick\`/${name}.AppImage`)
  f.controller.set(true)
  const command = String.raw`Exec=sh -c "exec \\"\\$1\\"" deskfleet `
  const path = '"/opt/Desk Fleet/\\\\"quoted\\\\"/back\\\\\\\\slash/\\\\$cash/\\\\`tick\\\\`/'
  expect(f.read().split("\n")).toContain(command + path + name.replace("%", "%%") + '.AppImage"')
})

test.each(["Hidden=true", "X-GNOME-Autostart-enabled=false"])("respects %s without enabling it during path refresh", (disabled) => {
  const f = fixture("/new/deskfleet.AppImage")
  const contents = `[Desktop Entry]\nType=Application\nName=DeskFleet\nExec=/old/deskfleet.AppImage\n${disabled}\n`
  f.write(contents)
  expect(f.controller.get()).toBe(false)
  f.controller.refresh()
  expect(f.read()).toBe(contents)
  expect(f.controller.set(true)).toBe(true)
})

test("startup refresh updates the executable after upgrading or moving while preserving other fields", () => {
  const f = fixture("/new location/deskfleet-0.3.3.AppImage")
  const contents = [
    "# Desktop environment preferences",
    "[Desktop Entry]",
    "Type=Application",
    "Name=DeskFleet",
    'Exec="/deleted/deskfleet-0.3.2.AppImage"',
    "Hidden=false",
    "X-GNOME-Autostart-enabled=true",
    "X-GNOME-Autostart-Delay=10",
    "[Desktop Action Other]",
    "Name=Other",
    "Exec=/other/command",
    "Hidden=true",
    "",
  ].join("\n")
  f.write(contents)
  expect(f.controller.get()).toBe(true)
  f.controller.refresh()
  expect(f.read()).toBe(contents.replace('Exec="/deleted/deskfleet-0.3.2.AppImage"', 'Exec="/new location/deskfleet-0.3.3.AppImage"'))
  expect(f.controller.get()).toBe(true)
})

test("startup refresh does not recreate a missing or manually deleted entry", () => {
  const f = fixture()
  f.controller.refresh()
  expect(existsSync(dirname(f.path))).toBe(false)
  f.controller.set(true)
  rmSync(f.path)
  f.controller.refresh()
  expect(existsSync(f.path)).toBe(false)
  expect(f.controller.get()).toBe(false)
})

test("startup refresh leaves an unchanged entry untouched", () => {
  const f = fixture()
  f.controller.set(true)
  const previous = new Date("2000-01-01T00:00:00Z")
  utimesSync(f.path, previous, previous)
  const modifiedAt = statSync(f.path).mtimeMs
  f.controller.refresh()
  expect(statSync(f.path).mtimeMs).toBe(modifiedAt)
})

test("filesystem read and write errors are reported", () => {
  const f = fixture()
  mkdirSync(f.path, { recursive: true })
  expect(() => f.controller.get()).toThrow()
  expect(() => f.controller.refresh()).toThrow()
  expect(() => f.controller.set(true)).toThrow()
  expect(() => f.controller.set(false)).toThrow()
})
