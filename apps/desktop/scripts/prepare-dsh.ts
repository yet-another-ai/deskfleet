import { bundledDshRuntime, electronDshHost } from "@deskfleet/dsh-runtime"
import { smokeDsh } from "@deskfleet/dsh-runtime/smoke"
import { stageDsh } from "@deskfleet/dsh-runtime/stage"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const directory = resolve(import.meta.dirname, "../out/dsh")
const executable = createRequire(import.meta.url)("electron") as string
await stageDsh(directory, "electron")
await smokeDsh(bundledDshRuntime(directory, electronDshHost(executable)))
