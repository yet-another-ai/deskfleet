import { runDaemonCli } from "./cli.ts"

runDaemonCli({ name: "node", version: process.versions.node }, [process.argv[1]!])
