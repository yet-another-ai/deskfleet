import { configureNativeBindings } from "@deskfleet/native"
import { runDaemonCli } from "./cli.ts"

// A literal .node require lets Bun embed the platform addon into the executable.
configureNativeBindings(() => require("../../../crates/node/deskfleet.node"))
runDaemonCli({ name: "bun", version: process.versions.bun! }, [])
