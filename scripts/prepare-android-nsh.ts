import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

interface CargoPackage { name: string; version: string; manifest_path: string }
interface CargoMetadata { packages: CargoPackage[] }

/** Use Cargo's checksum-verified, locked crate sources for the matching JNI Java classes. */
export function androidNshJavaSource(metadata: CargoMetadata): string {
  const packages = metadata.packages.filter(pkg => pkg.name === "nsh-platform-android")
  if (packages.length !== 1) throw new Error("Expected one locked nsh-platform-android dependency")
  const source = join(dirname(packages[0]!.manifest_path), "java")
  if (!existsSync(join(source, "com/longbridge/nsh/NshView.java"))) {
    throw new Error(`NSH ${packages[0]!.version} does not contain its Android Java sources`)
  }
  return source
}

export function prepareAndroidNsh(repoRoot: string): string {
  const metadata = JSON.parse(execFileSync("cargo", [
    "metadata", "--locked", "--format-version", "1", "--filter-platform", "aarch64-linux-android",
  ], { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as CargoMetadata
  const source = androidNshJavaSource(metadata)
  const destination = join(repoRoot, "packages/capacitor-bridge/android/build/generated/nsh/java")
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true })
  console.log(`Prepared pinned NSH Android Java bindings at ${destination}`)
  return destination
}

if (import.meta.main) prepareAndroidNsh(resolve(import.meta.dirname, ".."))
