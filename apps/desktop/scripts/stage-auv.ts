import { copyFile, cp, mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { binaryPath } from "@auv-js/cli/binary"

/** Linux's private libraries, OCR data, and licenses travel beside its executable. */
export async function stageAuv(): Promise<void> {
  const source = binaryPath()
  const destination = resolve(import.meta.dirname, "../out/auv")
  await rm(destination, { recursive: true, force: true })
  if (process.platform === "linux") {
    await cp(dirname(source), destination, { recursive: true, verbatimSymlinks: true })
  } else {
    await mkdir(destination, { recursive: true })
    await copyFile(source, join(destination, process.platform === "win32" ? "auv.exe" : "auv"))
  }
}

if (import.meta.main) await stageAuv()
