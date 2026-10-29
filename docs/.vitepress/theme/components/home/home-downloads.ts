export type InstallMode = "desktop" | "headless"
export type InstallPlatform = "macos" | "windows" | "linux"
export type LinuxArchitecture = "x64" | "arm64"

export const releasesPage = "https://github.com/yet-another-ai/deskfleet/releases/latest"

export interface ReleaseFile {
  name: string
  url: string
  size: number
}

export interface LatestRelease {
  version: string
  publishedAt: string
  files: ReleaseFile[]
}

interface GitHubRelease {
  tag_name: string
  published_at: string | null
  draft: boolean
  prerelease: boolean
  assets: { name: string; browser_download_url: string; size: number }[]
}

/** Resolve the published stable release in the browser, independently of the website build. */
export async function fetchLatestRelease(): Promise<LatestRelease | undefined> {
  try {
    const response = await fetch("https://api.github.com/repos/yet-another-ai/deskfleet/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!response.ok) return undefined
    const release = await response.json() as GitHubRelease
    if (release.draft || release.prerelease || !release.published_at) return undefined
    return {
      version: release.tag_name.replace(/^v/, ""),
      publishedAt: release.published_at,
      files: release.assets.map(file => ({ name: file.name, url: file.browser_download_url, size: file.size })),
    }
  } catch {
    return undefined
  }
}

export function findDownload(
  release: LatestRelease | undefined,
  mode: InstallMode,
  platform: InstallPlatform,
  linuxArchitecture: LinuxArchitecture,
  format: "installer" | "archive" = "installer",
): ReleaseFile | undefined {
  if (!release) return undefined
  if (format === "archive") {
    return mode === "desktop" && platform === "macos"
      ? release.files.find(file => file.name === `deskfleet-${release.version}-mac-arm64.zip`)
      : undefined
  }
  const target = platform === "macos" ? "macos-arm64" : platform === "windows" ? "windows-x64" : `linux-${linuxArchitecture}`
  const appImageArchitecture = linuxArchitecture === "x64" ? "x86_64" : linuxArchitecture
  const installer = platform === "macos" ? "mac-arm64.dmg" : platform === "windows" ? "win-x64.exe" : `linux-${appImageArchitecture}.AppImage`
  const name = mode === "headless" ? `deskfleet-${target}.tar.gz` : `deskfleet-${release.version}-${installer}`
  return release.files.find(file => file.name === name)
}

export function formatSize(bytes: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024 ** 2)} MB`
}
