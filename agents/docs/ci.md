# Continuous integration

DeskFleet follows [Heron's CI structure](https://github.com/minori-live/heron/blob/main/agents/docs/ci.md):
one orchestrator, reusable Test, Build, and Nix workflows, a shared setup action, and
a stable `Gate` result for branch protection.

## Workflow ownership

- `.github/workflows/ci.yml` handles pull requests, pushes to `main`, and manual
  runs. It classifies the changed files with the hosted runner's Node, calls
  Test, Build, and Nix, and combines their results in `Gate`. Configure `Gate` under
  the `CI` workflow as the required status check in repository branch protection.
  Successful runs on `main` then deploy the product website to GitHub Pages.
- `.github/workflows/test.yml` runs static checks and the desktop/Web/website builds
  once on Linux with `mise run ci:check:static`, plus Rust, daemon, and desktop
  tests on Linux, macOS, and Windows with `mise run test`. It supports reusable
  calls and manual runs. A separate Linux job runs real PostgreSQL integration
  tests, Valkey-backed Team TURN collection tests, and the owned-account/two-daemon remote
  workflow against the same pinned PostgreSQL 18.6 and Valkey images as local
  development, both directly and with relay-only peers through
  an isolated coturn container. It also validates the development Compose configuration.
  The same job drives the built Web and Electron clients under Xvfb through
  actual login, remote execution, archive/restore, and offline history flows.
  It installs Electron's Linux sandbox helper with root ownership and mode 4755
  before launching the clients.
  The Linux test matrix also runs native X11 capture/input tests serially under
  a disposable Xvfb server with `-noreset`, avoiding server resets when the last
  client disconnects between test cases.
- `.github/workflows/build.yml` builds artifacts, then packages Electron
  installers and Linux desktop archives. Ordinary CI runs use
  `mise run ci:build`; tagged releases build Web and Electron separately to give
  only Electron a fixed API origin.
  Its shared Rust task runs one napi-driven Cargo workspace build for the server
  and native addon,
  using the host target for both. SEA and Electron bundling consume that addon
  without compiling it again. The server is read from
  `target/<host-triple>/release/`, where `rustc --print host-tuple` identifies the
  native runner's triple.
  Pull requests use a Linux x64 smoke build; main and manual runs use the full
  platform matrix. Packaging keeps Cargo's parallel release codegen: 16 units,
  LTO off, no debug info, and stripped symbols. Windows packaging additionally
  passes `/DEBUG:NONE` to the MSVC linker through target-specific Rust flags,
  overriding rustc's `/DEBUG` default so vendored OpenSSL does not require a PDB
  during release linking. This applies only to Build jobs; test and development
  builds keep their debug information. Each target packages and verifies the
  standalone SEA daemon.
  The same matrix packages Electron installers and Linux desktop archives and
  smoke-tests the bundled server container on each native Linux runner. The
  Publish caller enables production configuration and macOS signing. PR, main,
  and manual Build runs do not bind
  the production environment: Statsig and Sentry stay disabled, and Electron
  defaults to `http://localhost:8080`. It supports reusable calls and manual runs.
- `.github/workflows/publish.yml` validates `v*` tags, calls Test and Build, then
  calls Nix with the desktop archives from Build. It creates a draft GitHub
  Release and pushes the server image to GHCR after all three workflows succeed.
- `.github/workflows/nix.yml` consumes the same-run Linux desktop archives from
  Build, generates a flake bundle, and checks the repackaged app under Xvfb.
  It preloads the archives into Nix's fixed-output store so checks can run before
  the release assets are published. CI includes it in `Gate`; documentation-only
  changes skip it alongside Build. Publish reuses the workflow and includes its
  generated `deskfleet-nix.tar.gz` in the release. The Nix workflow does not bind
  the production environment or read its variables or secrets.
- `.github/actions/setup-build/action.yml` installs locked tools and dependencies
  and configures shared caches for the Test and Build workflows.

The build matrix covers Linux x64/arm64, macOS arm64, and Windows x64. Each
server/daemon archive, such as `deskfleet-linux-x64.tar.gz`, contains
`deskfleet-server` and `deskfleet-daemon` (`.exe` on Windows).
Separate desktop artifacts contain macOS arm64 DMG/ZIP, Windows x64 NSIS, and
Linux x64/arm64 AppImages and desktop archives, plus updater YAML and blockmaps.
The Linux desktop archive names include the app version, such as
`deskfleet-<version>-linux-x64.tar.gz`. PRs exercise packaging on Linux x64.
The Linux x64 job also uploads `deskfleet-web` with the static Vue application.
Its API origin is the hosting origin, including tagged release artifacts;
deployments with a separate API origin build with `VITE_DESKFLEET_SERVER_URL`
as described in the Web guide. Publish includes this same-run Web artifact in
both server image architectures. The artifact remains available for independent
static hosting for 14 days; it is not added to the GitHub Release archives.

Smoke tests copy the daemon executable alone to an unrelated temporary directory,
clear Node's environment overrides and PATH, then check native information,
the bundled ACP adapter, startup, and the health endpoint. Unix tests also require
clean signal-driven shutdown; Windows tests terminate the process forcibly.

## Product website deployment

The static-check job uploads `docs/.vitepress/dist` as the `github-pages`
artifact on `main`, reusing the website build from `mise run ci:check:static`.
After `Gate` succeeds, the CI workflow deploys that artifact through the
`github-pages` environment. Both pushes and manual CI runs on `main` publish;
pull requests and other branches do not. Documentation-only pushes still
publish even when release packaging is skipped.

Only the deployment job receives `pages: write` and `id-token: write`; build
and test jobs keep read-only repository access. Deployment failures are
reported separately from the required `Gate` check.

Repository Settings → Pages must use **GitHub Actions** as the publishing
source. The configured custom domain is `www.deskfleet.org`, so VitePress uses
the default `/` base. Domain and HTTPS settings are managed in GitHub Pages.

## Tagged releases

Use a `vMAJOR.MINOR.PATCH` tag, optionally with a SemVer prerelease suffix such as
`v0.2.0-beta.1`. The tag must match the root `package.json`,
`apps/desktop/package.json`, and Cargo workspace version. Update those versions
and regenerate `Cargo.lock` before tagging. Build metadata (`+...`) is not
accepted because it cannot be represented in a container tag.

Publish calls the same Test and Build workflows used by CI, with the full
platform matrix and mandatory macOS signing/notarization, then validates the
Linux archives through Nix. It waits for all three before publishing. The Build
workflow keeps read-only repository access;
only the release job receives `contents: write`, and only the image job receives
`packages: write`.

Before the first tag, create the `production` environment under Repository
Settings → Environments. Set its deployment branch and tag policy to
**Selected branches and tags**, add a **Tag** rule matching `v*`, and allow no
branches. Keep production configuration in this environment, removing any
duplicate repository or organization variables and secrets. The Linux desktop
archives carry this configuration in the compiled app, including when repackaged
by Nix.

Configure these environment variables:

| Variable | Value |
| --- | --- |
| `VITE_DESKFLEET_SERVER_URL` | Required official API origin for Electron, such as `https://fleet.example.com`. A missing or empty value fails the release build. |
| `VITE_STATSIG_CLIENT_KEY` | Optional Statsig client-public SDK key for Web and Electron. Missing or blank disables analytics. |
| `VITE_STATSIG_ENVIRONMENT` | Optional Statsig environment for both clients; defaults to the Vite mode, `production`. |
| `VITE_SENTRY_DSN` | Optional public Sentry DSN for Web and Electron renderers. Missing, blank, or invalid disables error reporting. |
| `VITE_SENTRY_ENVIRONMENT` | Optional Sentry environment for both clients; defaults to the Vite mode, `production`. |

The reusable Build workflow binds its packaging job to `production` only when
Publish requests a production release. The caller passes the signing secret
names explicitly; the bound environment supplies their values. The official
API origin is injected only into Electron's build, so the Web artifact stays
same-origin.

Both clients receive the same Sentry release identifier automatically from the
Git tag, such as `deskfleet@v0.2.1`; no release variable needs configuring.
Source-map upload is not configured.

Keep production compilation in separate steps using each runner's native shell
(PowerShell on Windows). Running it through Git Bash selects Git's bundled Perl
instead of Strawberry Perl and can break the vendored OpenSSL build. The Bash
configuration check runs before either build and does not compile code.

Configure these secrets in the same environment:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate and private key in a PKCS#12 archive. |
| `MAC_CSC_KEY_PASSWORD` | Password for that archive. |
| `APPLE_API_KEY_P8` | Base64 App Store Connect API private key (`.p8`). |
| `APPLE_API_KEY_ID` | App Store Connect API key ID. |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID. |

The release overlay requires signing and notarization; missing credentials or a
failure prevents publication. PR, main, and manual Build runs package without
those credentials. Windows installers are unsigned in this initial pipeline.

macOS packaging rewrites the main and helper executables' Mach-O build UUIDs
before signing, giving each DeskFleet executable its own identity instead of
reusing Electron's UUIDs. macOS Local Network privacy uses those UUIDs to identify
the requesting app; collisions can apply an installed app's permission request
to another Electron app and leave direct WebRTC connections blocked. The bundle
also declares why DeskFleet needs local network access. Keep this processing
before code signing and notarization; see Apple's
[build UUID guidance](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems)
and [Local Network privacy guidance](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

Release validation on macOS must use the packaged app, because development
Electron has a separate OS permission identity. Verify direct terminal output
and live Session events from another machine after granting DeskFleet access in
**System Settings → Privacy & Security → Local Network**. Successful management
requests or inbound connections to the hosted daemon do not establish that the
renderer can initiate a direct peer connection.

Each tag produces a **draft** GitHub Release containing the desktop installers,
two Linux desktop archives, the `deskfleet-nix.tar.gz` flake bundle, four
server/daemon archives, updater metadata and blockmaps. Review its generated
notes and assets, then publish it in GitHub. Prerelease tags create prerelease
drafts.
Reruns can replace assets on a draft; they refuse to modify an already published
release.

The website reads GitHub's public `releases/latest` API in the browser and selects
the matching published stable release asset for the chosen platform and
architecture. Publishing a stable release makes it discoverable without another
Pages build. Drafts and prereleases do not replace the website's stable downloads;
failed requests and unavailable assets retain a link to GitHub Releases.

The installation section groups methods by platform: Homebrew, DMG, and ZIP on
macOS; the Windows installer; and AppImage, Nix, and desktop archives on Linux.
Nix and Linux desktop archives appear only when the published release contains
their assets. The Nix command uses that release's versioned flake URL. Homebrew
uses the official tap and does not display GitHub's release version as its own.
Headless downloads remain separate server/daemon archives. English, Chinese,
and Japanese pages share the same selection logic and localized instructions.

### Desktop updates

Electron uses `electron-updater` with the public GitHub provider for
`yet-another-ai/deskfleet`. Packaging generates `latest.yml`, `latest-mac.yml`,
`latest-linux.yml` and `latest-linux-arm64.yml`; the release job requires all four,
the macOS update ZIP and the Windows/ZIP blockmaps before creating its draft.
Each release carries its own metadata, including prereleases. GitHub's release
status controls discovery, so a draft cannot trigger an update and stable clients
do not receive prereleases. Publish complete releases with a higher version;
never replace assets on an existing published release.

The Electron main process checks for updates on startup and every 30 minutes.
Settings → Updates shows the installed version and can trigger a check on demand.
An available update appears at the bottom left; clicking it downloads the update,
stops the embedded daemon, then installs and restarts the app. Automatic checks
do not download or install, and ordinary app exit does not install an update.
Windows uses NSIS, macOS uses the signed update ZIP, and Linux requires running
the AppImage. Development runs do not check for updates.

Installed upgrades still need platform release testing: metadata generation and
unit tests do not demonstrate a successful installation on Windows, signed macOS
or either Linux architecture.

### Homebrew distribution

The macOS Apple Silicon Cask is maintained in
[`yet-another-ai/homebrew-tap`](https://github.com/yet-another-ai/homebrew-tap).
DeskFleet owns application versions, signing, and release assets; the tap owns
the Cask, release metadata validation, synchronization, and utility checks.
The Cask installs the same signed and notarized DMG as the release page and
retains the app's built-in updater. Install with:

```sh
brew install --cask yet-another-ai/tap/deskfleet
```

Cask synchronization lives only in the tap. It runs on a schedule and by manual
dispatch there; DeskFleet does not notify the tap and does not need a
`TAP_SYNC_TOKEN` or any other cross-repository secret for Homebrew. The tap
reads GitHub's latest stable Release, validates the DMG metadata, and updates
its synchronization PR. Homebrew verifies the installer's SHA-256 during
installation. Drafts, prereleases, and unreleased version changes do not
advance the Cask. Preserve published assets: the tap rejects same-version
digest changes and automatic downgrades.

Configure the tap's required check and auto-merge before relying on automatic
updates. The initial Cask can use an existing stable Release. Tap setup and
maintenance are documented in its
[maintenance guide](https://github.com/yet-another-ai/homebrew-tap/blob/main/agents/docs/maintenance.md).

If tap synchronization or PR checks fail, repair the reported problem and
retry in the tap:

```sh
gh workflow run sync-deskfleet.yml --repo yet-another-ai/homebrew-tap --ref main
```

Manual dispatch reconciles the latest stable Release without a tag input. A
delayed or failed sync leaves the published Release and desktop updater
available; the tap retains its previous Cask until synchronization and merge
succeed.

### Nix distribution

Nix installs the prebuilt Linux desktop archive for `x86_64-linux` or
`aarch64-linux`. For tagged releases, Build compiles the desktop app once per
architecture under the existing `production` environment and packages it as both
an AppImage and a `tar.gz`. The archive already contains the official API,
Statsig, and Sentry configuration. Changes to those variables take effect in the
next release.
Distribution packaging can reuse the archive for future deb, rpm, or AUR
packages as well.

Every release automatically generates `deskfleet-nix.tar.gz` from the templates
under `nix/`. This bundle contains a flake with a locked nixpkgs input and the
versioned GitHub Release URLs and SHA-256 hashes of both Linux desktop archives.
The repository's `nix/flake.nix` is a release template; install from a generated
release bundle. For a release containing that asset, replace `<VERSION>` with
its version without the `v` prefix:

```sh
nix profile add 'https://github.com/yet-another-ai/deskfleet/releases/download/v<VERSION>/deskfleet-nix.tar.gz'
```

Use `nix run` with the same URL to try that version. A versioned URL keeps the
selected release reproducible. The generated default package is `deskfleet`.
Nix manages installed package updates; the AppImage updater stays disabled.

The Nix derivation patches the packaged ELF interpreter and library paths,
installs the desktop entry and icons, and supplies the runtime libraries and
GStreamer plugins. It does not compile Rust or run pnpm. Electron, the native
addon, ASAR contents, ACP adapters, and embedded daemon come from the same app
as the release installers. The daemon continues to run in Electron's main
process.

The launcher identifies itself to Linux autostart through
`DESKFLEET_LAUNCHER`. After upgrading, launch the new version once to refresh an
enabled startup entry. GPU drivers and the user's desktop session services,
including Portal/PipeWire on Wayland, remain host responsibilities.

The Nix workflow downloads the desktop archives from Build in the same workflow
run and generates the flake bundle. It preloads those archives into Nix's
fixed-output store, allowing flake checks, installation, and smoke tests before
the versioned release URLs are public. Its installed-package smoke checks
native-addon loading, bundled ACP adapters, the packaged renderer, the hosted
daemon, startup registration through the Nix wrapper, and disabled self-updates.
On the disposable Ubuntu runner, the workflow allows Chromium's user namespace
sandbox through AppArmor and runs the installed package with sandboxing enabled.

`Gate` requires Nix validation on code changes, and Publish requires it before
creating the draft release or publishing the server image. Nix reuses the
configuration already compiled by Build, so it needs no production environment
access, configuration snapshot, synchronization workflow, or additional token.
Nix binary-cache publication is not configured.

### Server image

The same successful tag build pushes
`ghcr.io/yet-another-ai/deskfleet-server:<version>` as one Linux amd64/arm64 image.
Stable tags also update `:latest`; prerelease tags publish only their version.
This image push happens on the tag build, independently of the later manual
publication of the draft desktop release. It uses `GITHUB_TOKEN`, so no registry
password secret is needed. After the first push, set the GHCR package visibility
to public if anonymous image pulls are required; repository visibility alone does
not make a new package public. See the [server guide](../../apps/server/README.md)
for configuration and a container run example.

The image reuses the native Linux server binaries and built Web files from Build.
Publish downloads `deskfleet-web` from the same workflow run and includes it in
both architectures at `/usr/share/deskfleet/web`. The image sets
`DESKFLEET_WEB_DIRECTORY` to that directory, so one Actix process serves the Web
application and API. Both are upgraded and rolled back with the image tag.

Each Linux runner stages its Web build alongside the server binary, builds that
runtime image, and starts it against a disposable PostgreSQL container. The
smoke test checks `/healthz`, the Web entry point and assets, authentication-page
fallback, 404 responses for missing API routes and assets, and graceful shutdown
before uploading its archive. Docker does not compile the Rust server or Web app
again.

## Documentation-only changes

Static validation still runs for documentation changes. The independent runtime
test and build jobs can be skipped only when the complete change is ordinary
documentation under the classifier's explicit allowlist.

This static tier includes the website typecheck and VitePress build, even for
Markdown-only edits under `docs/content/`. Website theme components,
configuration, and assets require the full tier because they are not Markdown.

The classifier checks the PR merge-base-to-head diff or the entire main push's
before-to-after diff. Executable files, symlinks, skills, manifests, lockfiles,
tool configuration, and workflow changes require full validation. Empty or
unavailable diffs, malformed events, and classification errors also select the
full tier. Manual runs use full validation. Classification uses the hosted
runner's Node and does not install a toolchain. An older runtime or missing
output keeps the full tier.

`Gate` requires successful classification and Test. A skipped Build is accepted
only for a positively classified documentation-only change. Failed, cancelled,
or unexpectedly skipped required work fails the gate.

## Toolchains and caches

CI installs tools with `mise install --locked`, uses locked Cargo dependencies,
and installs the pnpm workspace with `--frozen-lockfile`.
Task definitions live in `mise.toml`; the workflows select tasks and execution
platforms instead of maintaining another set of validation commands.

GitHub-hosted macOS runners are often throttled by nodejs.org while downloading
the locked Node archive, slow enough that mise's download budget expires first.
The setup action rewrites `https://nodejs.org/dist/` to the npmmirror CDN on
macOS only. The lockfile still records the nodejs.org URL and checksum, and
mise checks the downloaded bytes against that checksum. Linux and Windows keep
using nodejs.org. A throttled Actions cache restore or save is retried for up
to two minutes; without that wait, HTTP 429 is treated as a missing tool cache.

When both suites are scheduled, daemon tests wait for Rust tests to finish.
Both create many SQLite catalogs; separating them avoids overlapping storage
workloads while daemon IPC deadlines are active. Running only `check:daemon`
does not add the Rust test suite.

Choose each test's SQLite storage from the behavior it asserts:

| Test boundary | SQLite storage |
| --- | --- |
| Catalog operations, Agent configuration, authorization, enrollment validation, IPC, peer negotiation, machine-reset coordination, live worktree preferences, and schedule/workspace races | Independent in-memory catalog per test and machine context |
| Schema upgrades, rollback, constraints, and transactions | In-memory database with the real migrations |
| Catalog identity, journal/history, archive, or pending-work recovery after closing and reopening the database | Temporary database file |
| Ownership checks through separate connections to the same catalog | Temporary database file |
| Production startup, packaged daemon, and end-to-end application smoke tests | Default file catalogs |

In-memory catalogs run the same migrations, foreign keys, and transaction logic
as file catalogs. Inject `openInMemoryCatalog` explicitly at `DaemonCatalog.init`
or through the daemon/runtime's `openCatalog` option; Rust behavior tests use
`LocalCatalog::open_in_memory`. Do not switch all CI databases through an
environment variable. Each replacement machine context gets a fresh catalog;
tests rebuilding only an Agent service keep their existing catalog open.

Git repositories and worktrees, discovery records, credential/settings JSON, and
terminal transcripts still use real temporary files. A restart test needs a file
catalog only if its asserted persisted state lives in SQLite: the provider-control
restart test uses a fresh in-memory catalog per daemon while checking and reloading
`agent-providers.json` through authenticated IPC.

The daemon catalog, shutdown, development-data isolation, durable registration
reset, and scheduled-session recovery tests retain file catalogs across restart.
Rust store tests retain file catalogs for identity, journal replay, archive, and
pending-question recovery, plus the independent-connection ownership test. These
cover persistence while behavior-only fixtures keep file creation and migration
I/O out of IPC and lifecycle timeout budgets.

Static and test jobs may restore the Cargo target cache. Build jobs use Cargo
download caches without restoring compiled targets. The setup action fetches
the locked crates and installs the workspace before saving those download caches,
so a main or tag miss stores the populated entry.

Cache keys include the runner OS and architecture. The pnpm store and the
Electron package download directory also include the `pnpm-lock.yaml` hash.
Cargo downloads include the `Cargo.lock` hash. Each key has a same-platform
restore prefix. `pnpm install` does not download Electron. The shared setup
restores `@electron/get`'s default cache, and the PostgreSQL job saves it after
`install-electron` on main and tags. Installed `node_modules` directories are
rebuilt from the lockfile.

All jobs use sccache 0.19.0 through the pinned `sccache-action` release.
Its directory is local to the job and is not stored in the GitHub Actions
cache. One Actions object per compilation filled the repository quota and
evicted the Windows Cargo target cache. `SCCACHE_LOG` is `warn`. Cargo target
caches are still saved from main only.

`mise run ci:report:sccache` reports cache hit, miss, write, and error counters.

Heron's Nix, coverage upload, Playwright, plug-in SDK, signing, and symbol-upload
jobs are not part of this workflow. DeskFleet keeps the orchestrator, the reusable
Test and Build workflows, and this cache policy.

## Local validation

```sh
mise install --locked
mise run check
mise run build
mise run daemon:smoke
```

These commands validate the current host. Hosted runners provide the other
supported operating systems and native architectures.
