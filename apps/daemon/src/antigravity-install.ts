import { posix, win32 } from "node:path"

/** Pinned from https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json. */
export const ANTIGRAVITY_VERSION = "1.4.5"

const checksums: Record<string, string> = {
  "darwin-arm64": "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
  "darwin-x64": "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
  "linux-x64": "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
  "linux-arm64": "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
  "win32-x64": "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50",
  "win32-arm64": "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c",
}

interface InstallContext {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}

export function antigravityInstallDirectory({ platform, env, home }: InstallContext): string {
  return platform === "win32"
    ? win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "DeskFleet", "providers", "antigravity")
    : posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "deskfleet", "providers", "antigravity")
}

/** Download the standalone ACP runtime, preserving its adjacent harness executable. */
export function antigravityInstaller(
  ctx: InstallContext & { arch: string; shell: string },
): { command: string; args: string[] } | string {
  const checksum = checksums[`${ctx.platform}-${ctx.arch}`]
  if (!checksum) return "Automatic Antigravity installation is unavailable for this operating system or architecture."
  const platform = ctx.platform === "win32" ? "windows" : ctx.platform
  const directory = ctx.platform === "darwin" ? "macos" : platform
  const arch = ctx.arch === "x64" ? "x86_64" : ctx.arch
  const url = `https://dl.google.com/agy-extensions/releases/${directory}/agy-acp-server-${ANTIGRAVITY_VERSION}-${platform}-${arch}.zip`
  const destination = antigravityInstallDirectory(ctx)
  if (ctx.platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    const script = `$ErrorActionPreference = 'Stop'
$destination = ${quote(destination)}
$work = Join-Path ([IO.Path]::GetTempPath()) ('deskfleet-antigravity-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $archive = Join-Path $work 'antigravity.zip'
  Invoke-WebRequest -Uri ${quote(url)} -OutFile $archive -UseBasicParsing
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne ${quote(checksum)}) { throw 'Antigravity download checksum mismatch.' }
  $extracted = Join-Path $work 'extracted'
  Expand-Archive -LiteralPath $archive -DestinationPath $extracted
  foreach ($file in @('agy_acp_server.exe', 'localharness_external.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $extracted $file) -PathType Leaf)) { throw ('Antigravity archive is missing ' + $file) }
  }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Get-ChildItem -LiteralPath $extracted -Force | Copy-Item -Destination $destination -Recurse -Force
  Write-Output ('Antigravity installed at ' + $destination)
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force
}`
    return { command: ctx.shell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script] }
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const hashCommand = ctx.platform === "darwin" ? "shasum -a 256" : "sha256sum"
  const script = `set -euo pipefail
destination=${quote(destination)}
work=$(mktemp -d "\${TMPDIR:-/tmp}/deskfleet-antigravity.XXXXXX")
trap 'rm -rf "$work"' EXIT
curl -fL --output "$work/antigravity.zip" ${quote(url)}
checksum=$(${hashCommand} "$work/antigravity.zip")
if [ "\${checksum%% *}" != ${quote(checksum)} ]; then
  echo 'Antigravity download checksum mismatch.' >&2
  exit 1
fi
unzip -q "$work/antigravity.zip" -d "$work/extracted"
for file in agy_acp_server.par localharness_external; do
  if [ ! -f "$work/extracted/$file" ]; then
    echo "Antigravity archive is missing $file" >&2
    exit 1
  fi
  chmod +x "$work/extracted/$file"
done
mkdir -p "$destination"
cp -R "$work/extracted/." "$destination/"
echo "Antigravity installed at $destination"`
  return { command: ctx.shell, args: ["-c", script] }
}
