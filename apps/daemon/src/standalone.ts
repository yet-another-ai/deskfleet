import { configureNativeBindings } from "@deskfleet/native"
import { runDaemonCli } from "./cli.ts"

declare const DESKFLEET_TARGET_MACOS_X64: boolean

// Bun resolves the target at build time and embeds the selected addon.
configureNativeBindings(() => DESKFLEET_TARGET_MACOS_X64
  ? require("../dist/macos-x64/deskfleet.node")
  : require("../../../crates/node/deskfleet.node"))
runDaemonCli({ name: "bun", version: process.versions.bun! }, [])
