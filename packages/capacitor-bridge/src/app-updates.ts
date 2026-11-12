import {
  AppUpdate,
  AppUpdateAvailability,
  AppUpdateResultCode,
  FlexibleUpdateInstallStatus,
  type AppUpdateInfo,
  type AppUpdatePlugin,
  type FlexibleUpdateState,
} from "@capawesome/capacitor-app-update"
import type { AutoDownloadUpdatesState } from "@deskfleet/client/settings"
import type { UpdateApi, UpdateState } from "@deskfleet/client/updates"
import { DeskFleetBridge, type DeskFleetBridgeCapacitorPlugin } from "./index.ts"

const AUTO_DOWNLOAD_STORAGE_KEY = "deskfleet.updates.autoDownload"
const PLAY_STORE_PACKAGE = "com.android.vending"
const LATEST_RELEASE_API_URL = "https://api.github.com/repos/yet-another-ai/deskfleet/releases/latest"

export type PlayUpdatePlugin = Pick<AppUpdatePlugin, "getAppUpdateInfo" | "startFlexibleUpdate" | "completeFlexibleUpdate" | "addListener">

export interface PlayUpdates {
  updates: UpdateApi
  getAutoDownload(): Promise<AutoDownloadUpdatesState>
  setAutoDownload(enabled: boolean): Promise<AutoDownloadUpdatesState>
}

interface GitHubReleasePayload {
  tag_name?: string
  published_at?: string | null
  draft?: boolean
  prerelease?: boolean
  assets?: { name?: string; browser_download_url?: string }[]
}

/**
 * Matches the versionCode formula in apps/web/android/app/build.gradle.kts:
 * major * 10_000_000 + minor * 100_000 + patch * 1_000 + (999 for releases, else the prerelease number).
 */
export function androidVersionCode(versionName: string): number | undefined {
  const [core, prerelease] = versionName.trim().replace(/^v/u, "").split("-", 2)
  const parts = core?.split(".")
  if (!parts || parts.length !== 3) return undefined
  const numbers = parts.map(part => (/^(?:0|[1-9]\d*)$/u.test(part) ? Number(part) : Number.NaN))
  if (numbers.some(value => !Number.isSafeInteger(value) || value < 0 || value > 99 && value !== numbers[0])) return undefined
  const [major, minor, patch] = numbers as [number, number, number]
  if (minor > 99 || patch > 99) return undefined
  const pre = prerelease === undefined
    ? 999
    : Math.min(998, Math.max(1, Number(/(\d+)$/u.exec(prerelease)?.[1] ?? "1") || 1))
  return major * 10_000_000 + minor * 100_000 + patch * 1_000 + pre
}

/**
 * Reverses the versionCode formula in apps/web/android/app/build.gradle.kts:
 * Google Play reports only the available versionCode, not its versionName.
 */
export function playVersionName(versionCode: string): string {
  const code = Number(versionCode)
  if (!Number.isSafeInteger(code) || code <= 0) return versionCode
  const base = `${Math.floor(code / 10_000_000)}.${Math.floor(code / 100_000) % 100}.${Math.floor(code / 1_000) % 100}`
  const pre = code % 1_000
  return pre === 999 ? base : `${base} (${versionCode})`
}

/**
 * Google Play flexible in-app updates. Play shows its own consent dialog before downloading;
 * automatic download means that dialog opens as soon as a check finds an update.
 */
export function createPlayUpdates(
  plugin: PlayUpdatePlugin = AppUpdate,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): PlayUpdates {
  const listeners = new Set<(state: UpdateState) => void>()
  let state: UpdateState = { status: "idle" }
  let currentVersion: string | undefined
  let autoDownload = storage.getItem(AUTO_DOWNLOAD_STORAGE_KEY) !== "false"
  // A version the user declined in Play's dialog is not prompted again automatically this run.
  let declinedVersion: string | undefined
  let installRequested = false
  let checking: Promise<UpdateState> | undefined
  let consenting: Promise<void> | undefined

  const snapshot = (): UpdateState => ({ ...state, ...(currentVersion ? { currentVersion } : {}) })
  const publish = (next: UpdateState): void => {
    state = next
    const value = snapshot()
    for (const listener of listeners) listener(value)
  }

  void plugin.addListener("onFlexibleUpdateStateChange", (update: FlexibleUpdateState) => {
    const version = state.version
    switch (update.installStatus) {
      case FlexibleUpdateInstallStatus.PENDING:
      case FlexibleUpdateInstallStatus.DOWNLOADING: {
        const total = update.totalBytesToDownload ?? 0
        const percent = total > 0 ? Math.floor(((update.bytesDownloaded ?? 0) / total) * 100) : 0
        publish({ status: "downloading", version, percent: Math.max(0, Math.min(100, percent)) })
        break
      }
      case FlexibleUpdateInstallStatus.DOWNLOADED:
        publish({ status: "downloaded", version, percent: 100 })
        if (installRequested) void complete().catch(() => {})
        break
      case FlexibleUpdateInstallStatus.INSTALLING:
        publish({ status: "installing", version, percent: 100 })
        break
      case FlexibleUpdateInstallStatus.FAILED:
        installRequested = false
        publish({ status: "error", version, error: "Google Play could not download the update" })
        break
      case FlexibleUpdateInstallStatus.CANCELED:
        installRequested = false
        publish(version ? { status: "available", version } : { status: "idle" })
        break
      case FlexibleUpdateInstallStatus.INSTALLED:
        installRequested = false
        publish({ status: "idle" })
        break
    }
  })

  function apply(info: AppUpdateInfo): void {
    currentVersion = info.currentVersionName
    const version = info.availableVersionCode ? playVersionName(info.availableVersionCode) : undefined
    if (info.installStatus === FlexibleUpdateInstallStatus.DOWNLOADED) publish({ status: "downloaded", version, percent: 100 })
    else if (info.installStatus === FlexibleUpdateInstallStatus.PENDING || info.installStatus === FlexibleUpdateInstallStatus.DOWNLOADING
      || info.updateAvailability === AppUpdateAvailability.UPDATE_IN_PROGRESS) {
      publish({ status: "downloading", version, percent: state.status === "downloading" ? state.percent : 0 })
    } else if (info.updateAvailability === AppUpdateAvailability.UPDATE_AVAILABLE && version && info.flexibleUpdateAllowed !== false) {
      publish({ status: "available", version })
    } else publish({ status: "idle" })
  }

  /** Opens Play's consent dialog; resolves once the user answers. Download progress arrives through events. */
  function consent(): Promise<void> {
    consenting ??= (async () => {
      // The plugin discards its cached info after every flexible flow, so each attempt needs fresh info.
      apply(await plugin.getAppUpdateInfo())
      if (state.status !== "available") return
      const version = state.version
      const { code } = await plugin.startFlexibleUpdate()
      if (code === AppUpdateResultCode.OK) {
        if (state.status === "available") publish({ status: "downloading", version, percent: 0 })
        return
      }
      if (code === AppUpdateResultCode.CANCELED) {
        declinedVersion = version
        installRequested = false
        publish({ status: "available", version })
        return
      }
      throw new Error(`Google Play could not start the update (code ${code})`)
    })().finally(() => { consenting = undefined })
    return consenting
  }

  async function complete(): Promise<void> {
    publish({ status: "installing", version: state.version, percent: 100 })
    // Play restarts the app into the new version.
    await plugin.completeFlexibleUpdate()
  }

  function fail(error: unknown): never {
    installRequested = false
    publish({ status: "error", version: state.version, percent: state.percent, error: error instanceof Error ? error.message : String(error) })
    throw error
  }

  function check(): Promise<UpdateState> {
    checking ??= plugin.getAppUpdateInfo().then(info => {
      apply(info)
      // A failed automatic prompt is not an install failure; the notice still offers Install.
      if (autoDownload && state.status === "available" && state.version !== declinedVersion) void consent().catch(() => {})
      return snapshot()
    }).finally(() => { checking = undefined })
    return checking
  }

  const updates: UpdateApi = {
    async get() { return snapshot() },
    check,
    async install() {
      if (state.status === "installing") return
      installRequested = true
      try {
        if (state.status === "downloaded") return await complete()
        if (state.status === "downloading") return
        await consent()
        // consent() may find a download that finished earlier; TypeScript cannot see that state change.
        if ((state as UpdateState).status === "downloaded" && installRequested) await complete()
      } catch (error) { fail(error) }
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  return {
    updates,
    async getAutoDownload() { return { enabled: autoDownload, installSource: "google_play" } },
    async setAutoDownload(enabled) {
      storage.setItem(AUTO_DOWNLOAD_STORAGE_KEY, String(enabled))
      autoDownload = enabled
      if (enabled && state.status === "available") {
        declinedVersion = undefined
        void consent().catch(() => {})
      }
      return { enabled, installSource: "google_play" }
    },
  }
}

export interface GitHubApkUpdatesOptions {
  getAppInfo(): Promise<{ version: string; build: string }>
  openExternal(url: string): Promise<void>
  fetchImpl?: typeof fetch
  releaseApiUrl?: string
}

/**
 * GitHub Releases update checks for sideloaded Android APK installs.
 * Installing opens the signed APK asset URL in the external browser without requiring REQUEST_INSTALL_PACKAGES.
 */
export function createGitHubApkUpdates(options: GitHubApkUpdatesOptions): PlayUpdates {
  const fetchFn = options.fetchImpl ?? fetch
  const releaseApiUrl = options.releaseApiUrl ?? LATEST_RELEASE_API_URL
  const listeners = new Set<(state: UpdateState) => void>()
  let state: UpdateState = { status: "idle" }
  let currentVersion: string | undefined
  let downloadUrl: string | undefined
  let checking: Promise<UpdateState> | undefined

  const snapshot = (): UpdateState => ({ ...state, ...(currentVersion ? { currentVersion } : {}) })
  const publish = (next: UpdateState): void => {
    state = next
    const value = snapshot()
    for (const listener of listeners) listener(value)
  }

  function check(): Promise<UpdateState> {
    checking ??= (async () => {
      const appInfo = await options.getAppInfo()
      currentVersion = appInfo.version
      const currentCode = Number(appInfo.build) || androidVersionCode(appInfo.version) || 0

      const response = await fetchFn(releaseApiUrl, {
        headers: { Accept: "application/vnd.github+json" },
      })
      if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`)
      const release = await response.json() as GitHubReleasePayload
      if (release.draft || release.prerelease || !release.published_at || !release.tag_name) {
        downloadUrl = undefined
        publish({ status: "idle" })
        return snapshot()
      }
      const latestVersion = release.tag_name.replace(/^v/u, "")
      const latestCode = androidVersionCode(latestVersion)
      const apkName = `deskfleet-${latestVersion}-android-arm64.apk`
      const asset = release.assets?.find(item => item.name === apkName && typeof item.browser_download_url === "string")
      if (latestCode !== undefined && latestCode > currentCode && asset?.browser_download_url) {
        downloadUrl = asset.browser_download_url
        publish({ status: "available", version: latestVersion })
      } else {
        downloadUrl = undefined
        publish({ status: "idle" })
      }
      return snapshot()
    })().catch(error => {
      publish(state.version ? { status: "available", version: state.version } : { status: "idle" })
      throw error
    }).finally(() => { checking = undefined })
    return checking
  }

  const updates: UpdateApi = {
    async get() { return snapshot() },
    check,
    async install() {
      if (!downloadUrl) await check()
      if (!downloadUrl || !state.version) throw new Error("No application update is available")
      try {
        await options.openExternal(downloadUrl)
      } catch (error) {
        publish({ status: "error", version: state.version, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  return {
    updates,
    async getAutoDownload() { return { enabled: false, installSource: "apk" } },
    async setAutoDownload() { throw new Error("Automatic update downloads are unavailable for APK installs") },
  }
}

export interface AndroidUpdatesOptions {
  getAppInfo(): Promise<{ version: string; build: string }>
  bridge?: Pick<DeskFleetBridgeCapacitorPlugin, "getInstallSource" | "openExternal">
  playPlugin?: PlayUpdatePlugin
  storage?: Pick<Storage, "getItem" | "setItem">
  fetchImpl?: typeof fetch
}

/**
 * Selects Google Play flexible updates when installed from Play (`com.android.vending`),
 * or GitHub Releases APK updates for sideloaded installs.
 */
export function createAndroidUpdates(options: AndroidUpdatesOptions): PlayUpdates {
  const bridge = options.bridge ?? DeskFleetBridge
  const listeners = new Set<(state: UpdateState) => void>()
  let resolved: Promise<PlayUpdates> | undefined

  const resolve = (): Promise<PlayUpdates> => {
    resolved ??= (async () => {
      let installer: string | null = null
      try {
        const result = await bridge.getInstallSource?.()
        installer = result?.installerPackageName ?? null
      } catch {
        installer = null
      }
      const target = installer === PLAY_STORE_PACKAGE
        ? createPlayUpdates(options.playPlugin, options.storage)
        : createGitHubApkUpdates({
            getAppInfo: options.getAppInfo,
            openExternal: url => bridge.openExternal({ url }),
            fetchImpl: options.fetchImpl,
          })
      target.updates.onChanged(next => {
        for (const listener of listeners) listener(next)
      })
      return target
    })()
    return resolved
  }

  return {
    updates: {
      async get() { return (await resolve()).updates.get() },
      async check() { return (await resolve()).updates.check() },
      async install() { return (await resolve()).updates.install() },
      onChanged(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    async getAutoDownload() { return (await resolve()).getAutoDownload() },
    async setAutoDownload(enabled) { return (await resolve()).setAutoDownload(enabled) },
  }
}
