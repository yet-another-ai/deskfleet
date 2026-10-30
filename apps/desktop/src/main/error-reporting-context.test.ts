import { afterEach, expect, test, vi } from "vitest"
import { desktopErrorReportingContext } from "./error-reporting-context.ts"

vi.mock("electron", () => ({ app: { getVersion: () => "0.2.2" } }))
afterEach(() => { vi.unstubAllGlobals() })

test.each([
  ["darwin", "macOS", "15.6"],
  ["win32", "Windows", "10.0.26100"],
  ["linux", "Linux", "6.12.0"],
])("reports %s product versions and runtime without machine identity", (platform, name, version) => {
  const getSystemVersion = vi.fn(() => version)
  vi.stubGlobal("process", {
    ...process, platform, arch: "arm64", getSystemVersion,
    versions: { ...process.versions, electron: "43.0.0", node: "24.0.0", chrome: "150.0.0.0" },
  })
  expect(desktopErrorReportingContext()).toEqual({
    os: { name, version }, architecture: "arm64", appVersion: "0.2.2",
    electronVersion: "43.0.0", nodeVersion: "24.0.0", chromeVersion: "150.0.0.0",
  })
  expect(getSystemVersion).toHaveBeenCalledExactlyOnceWith()
})
