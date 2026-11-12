import { AppUpdateAvailability, AppUpdateResultCode, FlexibleUpdateInstallStatus, type AppUpdateInfo, type FlexibleUpdateState } from "@capawesome/capacitor-app-update"
import { expect, test, vi } from "vitest"
import {
  androidVersionCode,
  createAndroidUpdates,
  createGitHubApkUpdates,
  createPlayUpdates,
  playVersionName,
  type PlayUpdatePlugin,
} from "./app-updates.ts"

function fakePlay(info: Partial<AppUpdateInfo>, consent = AppUpdateResultCode.OK) {
  let emit: ((state: FlexibleUpdateState) => void) | undefined
  const plugin = {
    getAppUpdateInfo: vi.fn(async () => ({
      currentVersionName: "0.13.1", currentVersionCode: "1301999",
      updateAvailability: AppUpdateAvailability.UPDATE_AVAILABLE, availableVersionCode: "1400999",
      flexibleUpdateAllowed: true, installStatus: FlexibleUpdateInstallStatus.UNKNOWN, ...info,
    })),
    startFlexibleUpdate: vi.fn(async () => ({ code: consent })),
    completeFlexibleUpdate: vi.fn(async () => {}),
    addListener: vi.fn(async (_event: string, listener: (state: FlexibleUpdateState) => void) => {
      emit = listener
      return { remove: async () => {} }
    }),
  } satisfies PlayUpdatePlugin
  const event = (installStatus: FlexibleUpdateInstallStatus, bytesDownloaded?: number, totalBytesToDownload?: number) =>
    emit!({ installStatus, bytesDownloaded, totalBytesToDownload })
  return { plugin, event }
}

function memoryStorage(values: Record<string, string> = {}) {
  return { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value } }
}

function releaseFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

test("encodes and decodes the Gradle versionCode formula", () => {
  expect(androidVersionCode("0.14.0")).toBe(1400999)
  expect(androidVersionCode("v10.20.30")).toBe(102030999)
  expect(androidVersionCode("0.14.0-rc.2")).toBe(1400002)
  expect(androidVersionCode("invalid")).toBeUndefined()

  expect(playVersionName("1400999")).toBe("0.14.0")
  expect(playVersionName("102030999")).toBe("10.20.30")
  expect(playVersionName("1400002")).toBe("0.14.0 (1400002)")
  expect(playVersionName("not-a-code")).toBe("not-a-code")
})

test("without automatic download a check only reports the available version", async () => {
  const { plugin } = fakePlay({})
  const play = createPlayUpdates(plugin, memoryStorage({ "deskfleet.updates.autoDownload": "false" }))
  expect(await play.updates.check()).toEqual({ status: "available", version: "0.14.0", currentVersion: "0.13.1" })
  expect(plugin.startFlexibleUpdate).not.toHaveBeenCalled()
  expect(await play.getAutoDownload()).toEqual({ enabled: false, installSource: "google_play" })
})

test("automatic download prompts once and waits for a click before restarting", async () => {
  const { plugin, event } = fakePlay({})
  const play = createPlayUpdates(plugin, memoryStorage())
  const states: unknown[] = []
  play.updates.onChanged(state => states.push(state.status))
  await play.updates.check()
  await vi.waitFor(() => expect(plugin.startFlexibleUpdate).toHaveBeenCalledOnce())
  event(FlexibleUpdateInstallStatus.DOWNLOADING, 50, 200)
  expect(await play.updates.get()).toMatchObject({ status: "downloading", percent: 25 })
  event(FlexibleUpdateInstallStatus.DOWNLOADED)
  expect(plugin.completeFlexibleUpdate).not.toHaveBeenCalled()

  await play.updates.install()
  expect(plugin.completeFlexibleUpdate).toHaveBeenCalledOnce()
  expect(states.at(-1)).toBe("installing")
})

test("an explicit install downloads through Play and completes when the download finishes", async () => {
  const { plugin, event } = fakePlay({})
  const play = createPlayUpdates(plugin, memoryStorage({ "deskfleet.updates.autoDownload": "false" }))
  await play.updates.check()
  await play.updates.install()
  expect(await play.updates.get()).toMatchObject({ status: "downloading", percent: 0 })
  event(FlexibleUpdateInstallStatus.DOWNLOADED)
  await vi.waitFor(() => expect(plugin.completeFlexibleUpdate).toHaveBeenCalledOnce())
})

test("a declined Play dialog is not reopened automatically, and an explicit install still can", async () => {
  const { plugin } = fakePlay({}, AppUpdateResultCode.CANCELED)
  const play = createPlayUpdates(plugin, memoryStorage())
  await play.updates.check()
  await vi.waitFor(() => expect(plugin.startFlexibleUpdate).toHaveBeenCalledOnce())
  await vi.waitFor(async () => expect((await play.updates.get()).status).toBe("available"))
  await play.updates.check()
  expect(plugin.startFlexibleUpdate).toHaveBeenCalledOnce()
  await play.updates.install()
  expect(plugin.startFlexibleUpdate).toHaveBeenCalledTimes(2)
  expect((await play.updates.get()).status).toBe("available")
})

test("a download already finished in an earlier run is reported as downloaded", async () => {
  const { plugin } = fakePlay({ installStatus: FlexibleUpdateInstallStatus.DOWNLOADED })
  const play = createPlayUpdates(plugin, memoryStorage())
  expect(await play.updates.check()).toMatchObject({ status: "downloaded", version: "0.14.0" })
  expect(plugin.startFlexibleUpdate).not.toHaveBeenCalled()
})

test("APK updates check GitHub releases/latest, open the APK asset in the browser, and report installSource apk", async () => {
  const openExternal = vi.fn(async () => {})
  const apkUrl = "https://github.com/yet-another-ai/deskfleet/releases/download/v0.14.0/deskfleet-0.14.0-android-arm64.apk"
  const github = createGitHubApkUpdates({
    getAppInfo: async () => ({ version: "0.13.1", build: "1301999" }),
    openExternal,
    fetchImpl: releaseFetch({
      tag_name: "v0.14.0",
      published_at: "2026-11-12T00:00:00Z",
      draft: false,
      prerelease: false,
      assets: [{ name: "deskfleet-0.14.0-android-arm64.apk", browser_download_url: apkUrl }],
    }),
  })

  expect(await github.getAutoDownload()).toEqual({ enabled: false, installSource: "apk" })
  expect(await github.updates.check()).toEqual({ status: "available", version: "0.14.0", currentVersion: "0.13.1" })
  await github.updates.install()
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(apkUrl)
})

test("APK updates ignore equal/older versions, drafts, prereleases, and releases missing the APK asset", async () => {
  const openExternal = vi.fn(async () => {})
  for (const payload of [
    { tag_name: "v0.13.1", published_at: "2026-11-12T00:00:00Z", draft: false, prerelease: false, assets: [{ name: "deskfleet-0.13.1-android-arm64.apk", browser_download_url: "https://example.invalid/a.apk" }] },
    { tag_name: "v0.15.0-beta.1", published_at: "2026-11-12T00:00:00Z", draft: false, prerelease: true, assets: [{ name: "deskfleet-0.15.0-beta.1-android-arm64.apk", browser_download_url: "https://example.invalid/a.apk" }] },
    { tag_name: "v0.15.0", published_at: "2026-11-12T00:00:00Z", draft: false, prerelease: false, assets: [] },
  ]) {
    const github = createGitHubApkUpdates({
      getAppInfo: async () => ({ version: "0.13.1", build: "1301999" }),
      openExternal,
      fetchImpl: releaseFetch(payload),
    })
    expect(await github.updates.check()).toEqual({ status: "idle", currentVersion: "0.13.1" })
  }
})

test("createAndroidUpdates selects Play for com.android.vending and GitHub Releases for sideloaded installs", async () => {
  const { plugin } = fakePlay({}, AppUpdateResultCode.OK)
  const playOnly = await createAndroidUpdates({
    getAppInfo: async () => ({ version: "0.13.1", build: "1301999" }),
    bridge: { getInstallSource: async () => ({ installerPackageName: "com.android.vending" }), openExternal: vi.fn(async () => {}) },
    playPlugin: plugin,
    storage: memoryStorage({ "deskfleet.updates.autoDownload": "false" }),
  })
  expect(await playOnly.getAutoDownload()).toEqual({ enabled: false, installSource: "google_play" })
  expect(await playOnly.updates.check()).toMatchObject({ status: "available", version: "0.14.0" })
  expect(plugin.getAppUpdateInfo).toHaveBeenCalledOnce()

  const openExternal = vi.fn(async () => {})
  const apkUrl = "https://github.com/yet-another-ai/deskfleet/releases/download/v0.14.0/deskfleet-0.14.0-android-arm64.apk"
  const sideloaded = await createAndroidUpdates({
    getAppInfo: async () => ({ version: "0.13.1", build: "1301999" }),
    bridge: { getInstallSource: async () => ({ installerPackageName: "com.google.android.packageinstaller" }), openExternal },
    playPlugin: plugin,
    storage: memoryStorage(),
    fetchImpl: releaseFetch({
      tag_name: "v0.14.0",
      published_at: "2026-11-12T00:00:00Z",
      draft: false,
      prerelease: false,
      assets: [{ name: "deskfleet-0.14.0-android-arm64.apk", browser_download_url: apkUrl }],
    }),
  })
  expect(await sideloaded.getAutoDownload()).toEqual({ enabled: false, installSource: "apk" })
  expect(await sideloaded.updates.check()).toEqual({ status: "available", version: "0.14.0", currentVersion: "0.13.1" })
  expect(plugin.getAppUpdateInfo).toHaveBeenCalledOnce() // not called again for sideloaded
  await sideloaded.updates.install()
  expect(openExternal).toHaveBeenCalledExactlyOnceWith({ url: apkUrl })
})
