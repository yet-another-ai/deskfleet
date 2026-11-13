import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

// Test the production Foundation endpoint without Capacitor, UIKit or viewer builds.
const workspace = mkdtempSync(join(tmpdir(), "deskfleet-ios-files-tests-"))
try {
  mkdirSync(join(workspace, "Sources", "DeskFleetLocalFiles"), { recursive: true })
  mkdirSync(join(workspace, "Tests", "DeskFleetLocalFilesTests"), { recursive: true })
  copyFileSync(new URL("../Sources/DeskFleetBridge/LocalFilesEndpoint.swift", import.meta.url), join(workspace, "Sources", "DeskFleetLocalFiles", "LocalFilesEndpoint.swift"))
  copyFileSync(new URL("./LocalFilesEndpointTests.swift", import.meta.url), join(workspace, "Tests", "DeskFleetLocalFilesTests", "LocalFilesEndpointTests.swift"))
  writeFileSync(join(workspace, "Package.swift"), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "DeskFleetLocalFiles", platforms: [.macOS(.v13)], targets: [
  .target(name: "DeskFleetLocalFiles"),
  .testTarget(name: "DeskFleetLocalFilesTests", dependencies: ["DeskFleetLocalFiles"])
])
`)
  const result = spawnSync("swift", ["test", "--disable-sandbox", "--package-path", workspace, "--cache-path", join(workspace, "cache"), "--config-path", join(workspace, "config"), "--security-path", join(workspace, "security")], {
    stdio: "inherit",
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(workspace, "module-cache") },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
