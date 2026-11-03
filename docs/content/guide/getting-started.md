# Run DeskFleet

You can run DeskFleet as a native desktop application (which hosts a local machine daemon in its main process), access your team's machines from the installable Web PWA, or deploy the standalone `deskfleet-daemon` executable on headless servers.

## Install the desktop app

### macOS (Apple Silicon)

Install DeskFleet from the official Homebrew tap:

```sh
brew install --cask yet-another-ai/tap/deskfleet
```

You can also download the `.dmg` disk image directly from [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases).

### Windows (`x64`)

Download and run the `.exe` installer from [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases).

### Linux (`x86_64` and `ARM64`)

- **Arch Linux (AUR)**:
  ```sh
  yay -S deskfleet-bin
  ```
- **Nix (with flakes enabled)**: Replace `<VERSION>` with the release version without its `v` prefix:
  ```sh
  nix profile add 'https://github.com/yet-another-ai/deskfleet/releases/download/v<VERSION>/deskfleet-nix.tar.gz'
  ```
  Use `nix run` with the same URL to launch DeskFleet without adding it to your profile. The Nix package installs the prebuilt desktop app and connects to the official DeskFleet service.
- **AppImage / Archive**: Download the `.AppImage` or `.tar.gz` archive for `x86_64` or `arm64` from [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases).

> [!NOTE]
> On Linux Wayland sessions, remote desktop sharing requires your desktop session's XDG Desktop Portal and PipeWire services along with a supported GPU driver.

## Enroll your first machine

1. Launch DeskFleet, sign in, and create or select a **Team**.
2. Click **Add machine** and choose **This computer** in the desktop app to register its embedded daemon with your team.
3. Open **Settings → Agents** on that machine to install, verify, and sign in to your preferred agent CLIs (such as Claude Code, Codex CLI, Cursor CLI, or Grok CLI).

Closing the desktop window keeps DeskFleet in the system tray so running agent sessions, PTY terminals, and scheduled tasks continue in the background. Use the system tray menu to quit the app when you want to stop its embedded daemon.

## Create a workspace and start a session

1. Select an enrolled machine and create a **Workspace** by adding one or more existing directories on that computer. The first directory serves as the default working directory.
2. Start a new **Session**, pick an agent provider, and describe your task.
3. Choose where the agent works:
   - **New worktree**: Creates an isolated Git checkout branched from committed `HEAD` so parallel sessions never conflict.
   - **Working directory**: Works directly inside the workspace's existing directories, including any uncommitted changes.

## Add a headless machine

For remote workstations, VMs, or build servers without a desktop session, run the standalone `deskfleet-daemon` single-executable binary (`deskfleet-daemon.exe` on Windows; use PowerShell 7 `pwsh`).

1. Download the headless daemon archive (`deskfleet-macos-arm64.tar.gz`, `deskfleet-linux-x64.tar.gz`, `deskfleet-linux-arm64.tar.gz`, or `deskfleet-windows-x64.tar.gz`) from [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases), or package it from source:
   ```sh
   mise run daemon:pack
   ```
   When built from source, the binary is written to `./apps/daemon/dist/deskfleet-daemon` (or `.\apps\daemon\dist\deskfleet-daemon.exe` on Windows).
2. Start the daemon and prepare an enrollment bundle for your backend and team:
   ```sh
   ./deskfleet-daemon prepare-enrollment --server-url https://your-backend.example --team-id <TEAM_ID>
   ```
3. In the desktop or web client, open **Add machine → Another machine** and paste the enrollment output. DeskFleet registers the machine with your team and displays its execution credential once.
4. Import the issued credential on the headless machine via standard input:
   ```sh
   ./deskfleet-daemon enroll --server-url https://your-backend.example < machine-credentials.json
   ```
5. Run `./deskfleet-daemon status` at any time to inspect registered teams without exposing secrets. See the [daemon guide](https://github.com/yet-another-ai/deskfleet/blob/main/apps/daemon/README.md) for the full CLI reference and storage layout.

## Run from source (local development stack)

To run the complete client, daemon, and server stack locally from source, install Git, [mise](https://mise.jdx.dev/), and Docker with Docker Compose. With Docker running:

```sh
git clone https://github.com/yet-another-ai/deskfleet.git
cd deskfleet
mise trust
mise install --locked
mise run install
mise run infra:up
mise run dev:seed
mise -E development run dev
```

- **Local infrastructure (`infra:up`)**: Starts local PostgreSQL, Valkey, and coturn TURN services in Docker Compose.
- **Seeded administrator (`dev:seed`)**: Creates a verified Site Admin in the local development database with email `admin@deskfleet.test` and password `deskfleet-dev-password`. You can also register a new account from the sign-in screen and open its verification link from `.local/mail/`.
- **API and Web client (`dev`)**: Starts the Actix Web backend on `http://localhost:8080` and the Web client on `http://localhost:5174/`.
- **Desktop client (`desktop:dev`)**: Keep `dev` running (Electron uses the local Web service for browser login), then run `mise run desktop:dev` in another terminal.
