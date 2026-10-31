export type InstallMode = "desktop" | "headless"
export type InstallPlatform = "macos" | "windows" | "linux"
export type LinuxArchitecture = "x64" | "arm64"
export type DesktopInstallMethod = "homebrew" | "installer" | "archive" | "nix"

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
    if (mode !== "desktop" || platform !== "linux") return undefined
    const name = `deskfleet-${release.version}-linux-${linuxArchitecture}.tar.gz`
    return release.files.find(file => file.name === name)
  }
  const target = platform === "macos" ? "macos-arm64" : platform === "windows" ? "windows-x64" : `linux-${linuxArchitecture}`
  const appImageArchitecture = linuxArchitecture === "x64" ? "x86_64" : linuxArchitecture
  const installer = platform === "macos" ? "mac-arm64.dmg" : platform === "windows" ? "win-x64.exe" : `linux-${appImageArchitecture}.AppImage`
  const name = mode === "headless" ? `deskfleet-${target}.tar.gz` : `deskfleet-${release.version}-${installer}`
  return release.files.find(file => file.name === name)
}

export function findNixDownload(release: LatestRelease | undefined): ReleaseFile | undefined {
  return release?.files.find(file => file.name === "deskfleet-nix.tar.gz")
}

export function desktopInstallMethods(release: LatestRelease | undefined, platform: InstallPlatform): DesktopInstallMethod[] {
  if (platform === "macos") return ["homebrew", "installer"]
  if (platform === "windows") return ["installer"]
  const methods: DesktopInstallMethod[] = ["installer"]
  if (findNixDownload(release)) methods.push("nix")
  if (findDownload(release, "desktop", "linux", "x64", "archive") || findDownload(release, "desktop", "linux", "arm64", "archive")) {
    methods.push("archive")
  }
  return methods
}

export function formatSize(bytes: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024 ** 2)} MB`
}
