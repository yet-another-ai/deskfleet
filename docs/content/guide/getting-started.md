# Run deskfleet

Find packaged versions on [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases). To try the current development version, use the source workflow below.

## Set up the development environment

Install Git, [mise](https://mise.jdx.dev/), and Docker with Docker Compose. With Docker running:

```sh
git clone https://github.com/yet-another-ai/deskfleet.git
cd deskfleet
mise trust
mise install --locked
mise run install
mise run infra:up
mise -E development run dev
```

The local infrastructure provides PostgreSQL, OIDC sign-in, and TURN. Leave the backend running, then start a client in another terminal:

```sh
mise run desktop:dev
```

Or use the web client:

```sh
mise run web:dev
```

Open `http://127.0.0.1:5174/` for the web client. The local development account is `alice@example.test` with password `password`. These credentials belong to the development setup.

## Add your first machine

Sign in, create a team, and choose **Add machine**. In the desktop app, select this computer to register its embedded daemon. Install and authenticate an agent CLI on that computer, then configure it in **Settings → Agents**.

Create a workspace using existing directories. Start a session, choose an agent, and describe the task. Choose **New worktree** for separate Git checkouts or **Working directory** to work directly in those directories.

## Add a headless machine

Build and run the standalone daemon on the target machine:

```sh
mise run daemon:pack
./apps/daemon/dist/deskfleet-daemon
```

On Windows, use PowerShell 7 and run `.\apps\daemon\dist\deskfleet-daemon.exe`. Use the daemon's `status` command to get its identity, paste that identity into **Add machine**, and import the issued credential using the enrollment instructions shown there.

Supported build targets are macOS Apple Silicon, Windows x64, and Linux x64/arm64. See the repository's [daemon guide](https://github.com/yet-another-ai/deskfleet/blob/main/apps/daemon/README.md) for the full command reference.

## Remote intervention

Remote desktop control is a core first-release feature under development. The homepage runs the current remote desktop interface, with a recorded product screen as its sample stream. You can connect, disconnect, and view it fullscreen. Check the release notes for the controls and platform support available in the version you install.
