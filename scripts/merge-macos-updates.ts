import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parse, stringify } from "yaml"

type MacUpdateInfo = {
  version: string
  files: { url: string; sha512: string }[]
}

export function mergeMacUpdates(directory: string, version: string): void {
  const arm64Path = join(directory, "latest-mac.yml")
  const x64Path = join(directory, "latest-mac-x64.yml")
  const readFeed = (path: string, arch: string): MacUpdateInfo => {
    const feed = parse(readFileSync(path, "utf8")) as MacUpdateInfo
    const zip = `deskfleet-${version}-mac-${arch}.zip`
    if (feed.version !== version || !feed.files?.some(file => file.url === zip && file.sha512)) {
      throw new Error(`Expected ${path} to list ${zip} for release ${version}`)
    }
    return feed
  }
  const arm64 = readFeed(arm64Path, "arm64")
  const x64 = readFeed(x64Path, "x64")
  // electron-updater reads one macOS channel file and selects the ZIP by architecture.
  writeFileSync(arm64Path, stringify({ ...arm64, files: [...arm64.files, ...x64.files] }))
  rmSync(x64Path)
}

if (import.meta.main) {
  const [directory, version] = process.argv.slice(2)
  if (!directory || !version) throw new Error("Usage: node scripts/merge-macos-updates.ts <release-assets> <version>")
  mergeMacUpdates(directory, version)
}
