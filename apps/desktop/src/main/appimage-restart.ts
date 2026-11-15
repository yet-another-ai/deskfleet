import { spawn } from "node:child_process"

// Wait for the old client to release its single-instance lock. Keep this shell
// as the new launcher's parent: NixOS routes AppImages through bubblewrap with
// --die-with-parent, so exec or a helper that exits after spawning kills the app.
const restartScript = `
while kill -0 "$1" 2>/dev/null; do
  sleep 0.1
done
shift
"$@" &
wait "$!"
`

export function startAppImageRestart(destination: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // Paths and launch flags are positional arguments, never shell source.
    const child = spawn("/bin/sh", ["-c", restartScript, "deskfleet-appimage-restart", String(process.pid), destination, ...args], {
      detached: true,
      stdio: "ignore",
      env,
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}
