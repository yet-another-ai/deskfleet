# Continuous integration

DeskFleet follows [Heron's CI structure](https://github.com/minori-live/heron/blob/main/agents/docs/ci.md):
one orchestrator, reusable Test, Build, and Nix server workflows, a shared setup
action, and a stable `Gate` result for branch protection. Desktop Nix and AUR
package validation are dedicated release workflows called by `publish.yml`;
DEB/RPM validation also runs after packaging builds in `ci.yml`.

## Workflow ownership

- `.github/workflows/ci.yml` handles pull requests, pushes to `main`, manual
  runs, and a daily full run at 03:17 UTC. It classifies the changed files with
  the hosted runner's Node, then runs Test in parallel with packaging jobs
  (`Build` and the experimental Nix server image) when classification requests a
  build. `Linux packages` still waits on `Build` because it downloads the same-run
  desktop archive artifact. `Gate` requires every selected job to succeed.
  Pull requests without packaging changes skip release packaging, relying on
  `Test` to validate code changes and leaving the smoke build to `main`. Draft
  pull requests run static checks only, automatically triggering the full runtime
  test suite upon `ready_for_review`. Configure `Gate` under the `CI` workflow as
  the required status check in repository branch protection. Successful push and
  manual runs on `main` then deploy the product website to GitHub Pages.
  A new pull request push cancels that pull request's previous run; runs on
  `main` and the daily run are never cancelled, so every main commit finishes
  and saves its caches. The reusable workflows declare no concurrency groups of
  their own. After each run on `main`, `Prune caches` deletes superseded cache
  entries, as described under [Toolchains and caches](#toolchains-and-caches).
- `.github/workflows/test.yml` runs a staged test pipeline. `Preflight` runs
  the checks that need no Rust compilation on Linux with `mise run ci:preflight`:
  rustfmt, cargo-shear, script tests, the Rust skills harness check, and the Web
  and website type checks. Platform tests and backend integration jobs wait for
  it (`needs: preflight`), providing fast-fail feedback before running on
  expensive runners. `Static checks` runs beside them with
  `mise run ci:check:static`: Clippy, the type checks that need the native
  addon, and the desktop, Web, and website builds. Test fails if either job
  fails, so `Gate` requires both. Furthermore, pull requests filter runtime test jobs by changed paths:
  cross-platform matrix checks (macOS arm64 and Windows x64) run only when
  native/cross-platform paths are modified (`crates/`, `apps/desktop/`, `apps/daemon/`,
  `*.rs`, root build configs, workflows, scripts, or patches), running Linux x64 only
  for frontend-only changes; backend integration tests run only when backend, server,
  database, or shared protocol files are touched (`apps/server/`, `crates/`, `compose.yaml`,
  etc.). Pushes to `main`, daily scheduled runs, and manual dispatches always run the
  full matrix and all integration suites. Once Preflight passes, active platform
  tests run in parallel. Linux uses `mise run test`, including the renderer Vitest
  project. macOS and Windows use `mise run ci:test:platform`: the same Rust, daemon,
  script, and desktop main/shared/client checks, without repeating the happy-dom renderer
  project. Each platform also runs `mise run desktop:smoke-dsh` against Electron's Node
  host. Local `mise run test` still runs both Vitest projects on every OS. It supports
  reusable calls and manual runs. When backend paths change, a separate Linux job runs
  real PostgreSQL integration tests, Valkey-backed Team TURN collection tests, and the
  owned-account/two-daemon remote workflow against the same pinned PostgreSQL 18.6 and
  Valkey images as local development, both directly and with relay-only peers through
  an isolated coturn container. It also validates the development Compose configuration.
  The same job drives the built Web and Electron clients under Xvfb through
  actual login, remote execution, archive/restore, and offline history flows.
  It installs Electron's Linux sandbox helper with root ownership and mode 4755
  before launching the clients.
  The Linux test matrix also runs native X11 capture/input tests serially under
  a disposable Xvfb server with `-noreset`, avoiding server resets when the last
  client disconnects between test cases. Before restoring Cargo outputs, that
  job removes the hosted image's unused Android SDK to leave disk space for
  Rust compilation and logs free space before and after cleanup.
- `.github/workflows/build.yml` builds artifacts, then packages Electron
  installers and Linux desktop archives. Ordinary CI runs use
  `mise run ci:build`; tagged releases build Web and Electron separately to give
  only Electron a fixed API origin.
  Its shared Rust task runs one napi-driven Cargo workspace build for the server,
  native addon, desktop viewer, and Windows service, using the host target.
  SEA and Electron bundling consume that addon without compiling it again.
  CI packaging sets `DESKFLEET_NATIVE_PREBUILT=1` so staging copies the viewer
  and service from that same workspace build instead of invoking Cargo again.
  A missing executable fails packaging. Local packaging builds these executables
  unless the caller explicitly selects prebuilt staging. The server is read from
  `target/<host-triple>/release/`, where `rustc --print host-tuple` identifies the
  native runner's triple.
  Pushes to `main` use a Linux x64 smoke build; pull requests run it only when
  packaging or distribution configurations change (`packaging/**`, `nix/**`,
  root flake files, packaging scripts, or packaging workflow files). Daily
  scheduled, manual, and tagged release runs use the full platform matrix.
  Smoke builds package only the Linux `tar.gz` desktop payload; the full matrix
  keeps every configured target, including AppImages and the macOS ZIP that Nix
  consumes.
  Desktop Nix packaging follows Build's Linux and macOS matrix during releases
  so it only downloads archives produced in the same run.
  `mise.ci.toml` gives CI release builds Cargo's parallel release codegen: 16
  units, LTO off, no debug info, and stripped symbols. Windows packaging additionally
  passes `/DEBUG:NONE` to the MSVC linker through target-specific Rust flags,
  overriding rustc's `/DEBUG` default so vendored OpenSSL does not require a PDB
  during release linking. Each target packages and verifies the
  standalone SEA daemon.
  Build runs on `ubuntu-24.04` and `ubuntu-24.04-arm`, while every other Linux
  job uses the newest hosted image, `ubuntu-26.04` or `ubuntu-26.04-arm`. The
  build image sets the glibc floor of the released binaries, and
  `scripts/check-linux-release.ts` installs the packages on Ubuntu 24.04.
  `ubuntu-latest` lags new images, so workflows name the version.
  The same matrix packages Electron installers and Linux desktop archives and
  smoke-tests the bundled server container on each native Linux runner. The
  Publish caller enables production configuration and macOS signing. PR, main,
  and manual Build runs do not bind
  the production environment: Statsig and Sentry stay disabled, and Electron
  defaults to `http://localhost:8080`. It supports reusable calls and manual runs.
- `.github/workflows/publish.yml` validates `v*` tags, calls Test and Build, then
  calls Nix, AUR, and Linux package validation with the desktop artifacts from
  Build. It creates a draft GitHub Release and pushes the server image after all
  five workflows succeed.
- `.github/workflows/nix.yml` consumes the same-run Linux desktop archives and
  macOS app ZIP from Build, generates a flake bundle, checks the repackaged Linux
  app under Xvfb, and verifies the macOS bundle's signatures on macOS.
  It preloads each archive into Nix's fixed-output store so checks can run before
  the release assets are published. Publish reuses the workflow and includes its
  generated `deskfleet-nix.tar.gz` in the release. The Nix workflow does not bind
  the production environment or read its variables or secrets. It is dedicated to
  release publication and excluded from daily CI.
- `.github/workflows/nix-server.yml` builds the experimental server and Web image
  from source with the root flake, loads it, and runs the existing server image
  smoke test. It runs in parallel with Test and Build under the same
  packaging-change gate, and its result is required by `Gate`. It follows the
  native Linux smoke/full matrix and uploads each tested image as
  `deskfleet-server-nix-<platform>` for three days. These images do not replace
  the official image published by the tag workflow.
- `.github/workflows/aur.yml` generates the Arch package from the same-run Linux
  x86_64 desktop archive and builds, installs, smoke-tests, and removes it inside
  a disposable Arch container. Publish requires it before creating the draft or
  pushing the server image. It needs no AUR credentials and is excluded from daily
  CI.
- `.github/workflows/linux-packages.yml` repackages the same-run Linux desktop
  archives into Debian `.deb` and RPM packages for the native architecture. It
  installs, reinstalls, smoke-tests, and removes each package in disposable
  Ubuntu and Fedora containers, then uploads the validated packages. CI runs the
  x64 variant after packaging builds; Publish validates both architectures and
  includes the uploaded packages in the draft release.
- `.github/actions/setup-mise/action.yml` is the only place that installs mise
  and its locked tools. Jobs that need only Node pass `tools: node`. It selects
  the CI mise environment and retries the install once after a transient
  failure: hosted macOS runners have SIGKILL'd rustup during the first attempt.
- `.github/actions/setup-build/action.yml` calls setup-mise, then installs the
  workspace and configures shared caches for the Test and Build workflows. It
  writes a cache restore summary for each job.

The build matrix covers Linux x64/arm64, macOS arm64, and Windows x64. Each
server/daemon archive, such as `deskfleet-linux-x64.tar.gz`, contains
`deskfleet-server` and `deskfleet-daemon` (`.exe` on Windows).
Separate desktop artifacts contain macOS arm64 DMG/ZIP, Windows x64 NSIS, and
Linux x64/arm64 AppImages and desktop archives, plus updater YAML and blockmaps.
The Linux desktop archive names include the app version, such as
`deskfleet-<version>-linux-x64.tar.gz`. PRs and main pushes exercise packaging on
Linux x64.
The Linux x64 job also uploads `deskfleet-web` with the static Vue application.
Its API origin is the hosting origin, including tagged release artifacts;
deployments with a separate API origin build with `VITE_DESKFLEET_SERVER_URL`
as described in the Web guide. Publish includes this same-run Web artifact in
both server image architectures. The artifact remains available for independent
static hosting for 14 days; it is not added to the GitHub Release archives.

The standalone archive includes `dsh/` beside the daemon executable, containing
the pinned DeepSeek Harness package tree, private Node executable, and licenses.
The build task prepares this payload separately from SEA bundling through
`dsh:stage`. Desktop builds prepare the package tree in `out/dsh` and smoke-test
it with Electron before Vite runs; packaging places that tree in resources
without a private Node executable. Desktop launches dsh using Electron's Node
mode. `packages/dsh-runtime` owns both deployment paths and smoke checks.
Staging uses an offline production deploy from the workspace lockfile and
preserves upstream plugins, native modules, and subprocess helpers.
After desktop packaging, `desktop:smoke-packaged-dsh` runs the installed
executable against its resources with the configured Electron fuses. This
also checks that the package tree was copied and no private Node was included.

Smoke tests copy the daemon executable and `dsh/` to an unrelated temporary directory,
clear Node's environment overrides and PATH, then check native information,
the bundled ACP adapter, the DeepSeek ACP handshake, startup, and the health
endpoint. Unix tests also require clean signal-driven shutdown; Windows tests terminate the process forcibly.

## Product website deployment

The static-check job uploads `docs/.vitepress/dist` as the `github-pages`
artifact on `main`, reusing the website build from `mise run ci:check:static`.
After `Gate` succeeds, the CI workflow deploys that artifact through the
`github-pages` environment. Both pushes and manual CI runs on `main` publish;
scheduled runs, pull requests, and other branches do not. Documentation-only
pushes still publish even when release packaging is skipped.

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
Linux archives through AUR and DEB/RPM package installation and both desktop
payloads through Nix. It waits for all five before publishing. The Build
workflow keeps read-only repository access; only the release job receives
`contents: write`, and only the image job receives `packages: write`.

Before the first tag, create the `production` environment under Repository
Settings → Environments. Set its deployment branch and tag policy to
**Selected branches and tags**, add a **Tag** rule matching `v*`, and a **Branch**
rule for `main` so AUR synchronization can also run by manual dispatch. Keep
production configuration in this environment, removing any
duplicate repository or organization variables and secrets. The desktop
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
| `SENTRY_ORG`, `SENTRY_PROJECT` | Sentry organization and project slugs; required for source-map upload when a valid DSN is configured. |
| `SENTRY_URL` | Optional self-hosted Sentry URL; defaults to `https://sentry.io/`. |
| `IOS_APP_PROFILE_NAME` | Exact name of the existing App Store Connect provisioning profile for `ai.yetanother.deskfleet`. |
| `IOS_BROADCAST_PROFILE_NAME` | Exact name of the existing App Store Connect provisioning profile for `ai.yetanother.deskfleet.BroadcastUpload`. |

The reusable Build workflow binds its packaging job to `production` only when
Publish requests a production release. The caller passes the signing secret
names explicitly; the bound environment supplies their values. The official
API origin is injected only into Electron's build, so the Web artifact stays
same-origin.

Both clients receive the same Sentry release identifier automatically from the
Git tag, such as `deskfleet@v0.2.1`; no release variable needs configuring.
Tagged builds generate hidden source maps and upload them after compilation,
before packaging. The Web distribution is `web`; desktop uses the matrix platform.
Upload validates all three bundle groups, waits for processing, and fails the
release if reporting is configured but credentials/maps are missing or delivery
fails. Maps are removed from the public Web output. See [error reporting](error-reporting.md#source-maps).

Keep production compilation in separate steps using each runner's native shell
(PowerShell on Windows). Running it through Git Bash selects Git's bundled Perl
instead of Strawberry Perl and can break the vendored OpenSSL build. The Bash
configuration check runs before either build and does not compile code.

Configure these secrets in the same environment:

| Secret | Value |
| --- | --- |
| `SENTRY_AUTH_TOKEN` | Token with source-map upload access, required when Sentry reporting is configured. Available only in the upload step. |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate and private key in a PKCS#12 archive. |
| `MAC_CSC_KEY_PASSWORD` | Password for that archive. |
| `APPLE_API_KEY_P8` | Base64 App Store Connect Team API private key (`.p8`). Developer access is sufficient for downloading existing iOS profiles and uploading builds. Individual keys cannot access provisioning endpoints. |
| `APPLE_API_KEY_ID` | App Store Connect API key ID. |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID. |
| `APPLE_TEAM_ID` | Apple Developer Team ID that owns the iOS distribution certificate and provisioning profiles. |
| `IOS_DIST_CERT_P12` | Base64 Apple Distribution certificate and private key in a PKCS#12 archive (`.p12`). |
| `IOS_DIST_CERT_PASSWORD` | Password for that iOS distribution PKCS#12 archive. |
| `ANDROID_KEYSTORE_BASE64` | Base64 Android upload keystore (`.jks` or `.keystore`). |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password for the Android upload key. |
| `ANDROID_KEY_ALIAS` | Key alias inside the Android upload keystore. |
| `ANDROID_KEY_PASSWORD` | Key password for the Android upload alias. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Play Developer API service account JSON credentials for publishing to the `internal` track. |

The release overlay requires signing and notarization; missing credentials or a
failure prevents publication. PR, main, and ordinary manual Build runs package
without those credentials. The explicit `signed_ios` manual Build option binds
only the iOS job to `production`. Windows installers are unsigned in this initial
pipeline.

Signed macOS builds use the desktop `package` script with the release overlay,
so the native viewer is built and staged before electron-builder bundles and
signs it. Keep this shared packaging entry point for both signed and unsigned
installers.

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
two Linux desktop archives, four Linux distribution packages (`.deb` for amd64
and arm64, `.rpm` for x86_64 and aarch64), the `deskfleet-nix.tar.gz` flake
bundle, four server/daemon archives, updater metadata and blockmaps, and the
Android arm64 APK (`deskfleet-<version>-android-arm64.apk`). Review its
generated notes and assets, then publish it in GitHub. Prerelease tags create
prerelease drafts.
The APK is signed with the Android upload key, while Google Play installs carry
Play's app signing key. Android cannot update one installation from the other
source; switching requires uninstalling first. APK installations check GitHub's
`releases/latest` endpoint instead of Google Play and open the newer signed APK
in the system browser when the user accepts an update.
Reruns can replace assets on a draft; they refuse to modify an already published
release.

The website reads GitHub's public `releases/latest` API in the browser and selects
the matching published stable release asset for the chosen platform and
architecture. Publishing a stable release makes it discoverable without another
Pages build. Drafts and prereleases do not replace the website's stable downloads;
failed requests and unavailable assets retain a link to GitHub Releases.

The installation section groups methods by platform: Homebrew and DMG on macOS;
the Windows installer; and AppImage, DEB, RPM, AUR, Linux Nix, and desktop
archives on Linux. The macOS ZIP is reserved for the updater and Nix, and is not
offered as a website installation method; macOS Nix users follow the nix-darwin
instructions in the guide. DEB, RPM, Linux Nix, and Linux desktop archives
appear only when the published release contains their assets. The Nix command
uses that release's versioned flake URL. Homebrew uses the official tap. AUR
links to the `deskfleet-bin` package page and remains available independently of
GitHub release assets. Neither Homebrew nor AUR displays GitHub's release
version as its own. Headless downloads remain separate server/daemon archives.
English, Chinese, and Japanese pages share the same selection logic and
localized instructions.

### iOS distribution signing and TestFlight

Tagged iOS releases and signed rehearsals reuse one Apple Distribution identity
and two existing App Store Connect provisioning profiles. The main app and
BroadcastUpload extension each have their own profile; both profiles must contain
the certificate in `IOS_DIST_CERT_P12` and the
`group.ai.yetanother.deskfleet` entitlement. In Apple Developer's Certificates,
Identifiers & Profiles, an Admin or Account Holder creates these profiles once,
selecting the explicit Bundle ID and the same distribution certificate for each.
Set the two profile names in the production variables above. No profile file
Secrets, Development certificates, device UDIDs, or development profiles are
needed for this release path.

The signing preparation step imports the P12 into a temporary keychain, then
`scripts/prepare-ios-signing.ts` downloads the named profiles through read-only
App Store Connect API calls. Before compiling, it validates the usable
Distribution identity, certificate and profile expiry, Team, Bundle IDs,
certificate binding, and App Group. Profile UUIDs and the signing certificate's
fingerprint are derived from the validated materials. A Developer **Team** key
can perform this preparation; the CI never creates or repairs certificates or
profiles. Renew the distribution certificate and regenerate its profiles when
they expire, are revoked, or the required entitlements change.

`scripts/package-ios-release.ts` explicitly uses manual distribution signing for
both archive and export. Profiles apply only to their owning application targets,
not SwiftPM libraries. Xcode receives no API credentials or permission to create
signing assets. Local Debug signing remains automatic, while ordinary CI builds
without signing. iOS packaging and TestFlight upload select Xcode 26.6 explicitly
on `macos-26`; changing the pinned toolchain requires a reviewed workflow change.
Credentials and the installed profiles are removed even when a step fails.
Failed builds retain the archive result bundle and build/export logs in the
`deskfleet-ios-diagnostics` artifact for seven days; private keys, keychains,
downloaded profiles, and the archive itself are not uploaded there.

The `deskfleet-ios` artifact contains `App.ipa` and `release.json`, which records
the Bundle ID, marketing version, and build number. CI assigns the build number
from its run number and attempt, using the same value in the app and extension.
The first tagged release with this numbering scheme must use a new marketing
version; an already-uploaded version may have a higher legacy build number.
An upload retry uses the artifact's existing version rather than allocating a
new build number. `scripts/publish-ios-release.ts` checks Apple's upload records
before sending the IPA: completed uploads are reused, processing uploads are
polled, and failed uploads report Apple's error. Transmission errors also check
the upload state before reporting failure. The job succeeds only after Apple
finishes processing; a processing timeout can be retried without rebuilding.
This publishes to TestFlight and does not submit the app for App Review.

Before the next release tag, run **Build → Run workflow → signed_ios = true** on
a branch allowed by the production environment's deployment rules. This skips
desktop and Android jobs, uses the same signing path, and produces the IPA and
metadata without uploading to TestFlight. Inspect the main app and extension's
signatures and profiles in that artifact. Validate the proposed Developer Team
key in this rehearsal before switching production back from an Admin key. The
`APPLE_API_*` secrets are also used by macOS notarization, so keep their declarations
and verify that shared consumer when rotating the key.

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
**Settings → Preferences → Automatically download updates** is enabled by default
and saved in `updates.json` under Electron's `userData` directory. When enabled,
discovered updates download in the background and stop at the confirmation state;
clicking **Update and restart** stops the embedded daemon, then installs and
restarts the app. When disabled, clicking **Update and restart** downloads the
update first before installing and restarting. Ordinary app exit does not install
an update.
Windows uses NSIS, macOS uses the signed update ZIP, and Linux requires running
the AppImage. Windows updates use the published blockmap for differential
downloads; electron-updater falls back to a full installer when a differential
download cannot be applied. Development runs do not check for updates.

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

### AUR distribution

The `deskfleet-bin` package repackages the versioned Linux desktop archives used
by Nix, retaining their bundled Electron and hosted daemon. The AUR recipe
installs the application and its desktop integration; Arch manages upgrades and
the AppImage updater stays disabled. The generator accepts the two desktop
archives and produces `PKGBUILD` and its helper files. The generated `.SRCINFO`
and package must be verified on Arch before publication.

`.github/workflows/aur-publish.yml` reconciles GitHub's latest published stable
release on release publication or manual dispatch. It uses the current default
branch packaging implementation and the selected release version, downloads
both desktop archives, computes their checksums, builds the x86_64 package in
Arch, and uploads the recipe as an Actions artifact. Drafts and prereleases do
not advance AUR. A release without both desktop archives cannot be synchronized.

Stable release publication automatically synchronizes AUR after package
validation. The synchronization job uses the `production` environment. Prepare
the following configuration before publishing:

- Confirm `deskfleet-bin` is available in AUR, or arrange maintainership of the
  existing package. Register a dedicated SSH public key with the AUR account.
- In the `production` environment, add its private key as the Actions secret
  `AUR_SSH_PRIVATE_KEY` and a verified `known_hosts` entry for `aur.archlinux.org`
  as the variable `AUR_SSH_KNOWN_HOSTS`. Verify the host key through a trusted
  channel before recording it.

Manual dispatch defaults to dry-run and does not push to AUR:

```sh
gh workflow run aur-publish.yml --ref main
```

To retry publication of the latest stable release, explicitly disable dry-run:

```sh
gh workflow run aur-publish.yml --ref main -f dry_run=false
```

The workflow compares `pkgver` and `pkgrel` with the existing AUR package; it
refuses downgrades and changes without a version increase. For an intentional
same-version recipe change, increase `pkgrel` in `packaging/aur/PKGBUILD.in`,
run and review a dry run, then retry publication. A failed sync leaves the
previous AUR package intact. The AUR repository contains the recipe and helper
files, not the downloaded application archives.

### DEB and RPM distribution

Each release repackages the prebuilt Linux desktop archive into Debian and RPM
packages instead of rebuilding the application:

| Asset | Package manager | Architecture |
| --- | --- | --- |
| `deskfleet-<version>-linux-amd64.deb` | `apt` / `dpkg` | x86_64 |
| `deskfleet-<version>-linux-arm64.deb` | `apt` / `dpkg` | arm64 |
| `deskfleet-<version>-linux-x86_64.rpm` | `dnf` / `rpm` | x86_64 |
| `deskfleet-<version>-linux-aarch64.rpm` | `dnf` / `rpm` | aarch64 |

Both formats install the Electron app under `/usr/lib/deskfleet`, a
`/usr/bin/deskfleet` launcher, the desktop entry, the icon, and license files.
The launcher sets `DESKFLEET_LAUNCHER` for Linux autostart and unsets `APPIMAGE`
so package-managed installs never self-update. Package managers own upgrades.
`scripts/package-linux-release.ts` extracts and validates each versioned desktop
archive, applies the same payload, and builds with `dpkg-deb` and `rpmbuild`.
SemVer prereleases are translated to `~` in package versions so
`1.2.3-rc.1` sorts before `1.2.3` in both package managers.

`.github/workflows/linux-packages.yml` builds each architecture on its native
Ubuntu runner. It then installs, reinstalls, smoke-tests, and removes the
packages inside disposable Ubuntu 24.04 and Fedora containers. The
installed-package smoke covers the native addon, PTY execution, bundled ACP
adapters, DeepSeek Harness and its native FFI, the packaged renderer, the hosted
daemon, autostart through the launcher, and disabled self-updates. Validation
also requires `chrome-sandbox` to remain setuid root; Chromium keeps its sandbox
enabled. The packages are unsigned, like the Windows installer. Repositories and
users that require signatures must sign or verify them independently.

### Nix distribution

Nix installs the prebuilt Linux desktop archive for `x86_64-linux` or
`aarch64-linux`. On Apple Silicon, the same release flake exposes the signed
macOS app bundle for nix-darwin. For tagged releases, Build compiles the desktop
app once per architecture under the existing `production` environment and
packages Linux as an AppImage and a `tar.gz`, and macOS as a signed ZIP. The
archives already contain the official API, Statsig, and Sentry configuration.
Changes to those variables take effect in the next release. The same Linux
archive supplies the DEB, RPM, AUR, and Linux Nix packages.

Every release automatically generates `deskfleet-nix.tar.gz` from the templates
under `nix/`. This bundle contains a flake with a locked nixpkgs input and the
versioned GitHub Release URLs and SHA-256 hashes of both Linux desktop archives
and the macOS app ZIP. The repository's `nix/flake.nix` is a release template;
install from a generated release bundle. For a release containing that asset,
replace `<VERSION>` with its version without the `v` prefix:

```sh
nix profile add 'https://github.com/yet-another-ai/deskfleet/releases/download/v<VERSION>/deskfleet-nix.tar.gz'
```

Use `nix run` with the same URL to try that version. A versioned URL keeps the
selected release reproducible. The generated default package is `deskfleet`.
Nix manages installed package updates; the AppImage updater stays disabled.

For macOS, add the release bundle as a nix-darwin flake input, apply
`overlays.default`, and add `pkgs.deskfleet` to `environment.systemPackages`.
nix-darwin's application activation copies the bundle to
`/Applications/Nix Apps` and owns upgrades. Do not install the macOS app with
`nix profile add`: a profile entry does not register the app bundle with
LaunchServices or place it under `/Applications`.

The Linux Nix derivation patches the packaged ELF interpreter and library paths,
installs the desktop entry and icons, and supplies the runtime libraries and
GStreamer plugins. The macOS derivation only unpacks the signed ZIP into
`$out/Applications/deskfleet.app`; it disables fixup and stripping so the
Developer ID signatures on every Mach-O file survive. Neither derivation
compiles Rust or runs pnpm. Electron, the native addon, ASAR contents, ACP
adapters, and embedded daemon come from the same app as the release installers.
The daemon continues to run in Electron's main process. Koffi's unused musl
variant is removed from the glibc package before ELF fixup; its glibc variant
remains subject to dependency validation.

The updater gate disables electron-updater when a packaged macOS app runs from
`/nix/store` or `/Applications/Nix Apps`. Nix and nix-darwin therefore remain
the only owners of the installed version; the read-only app bundle is never
replaced by a downloaded update.

The launcher identifies itself to Linux autostart through
`DESKFLEET_LAUNCHER`. After upgrading, launch the new version once to refresh an
enabled startup entry. GPU drivers and the user's desktop session services,
including Portal/PipeWire on Wayland, remain host responsibilities.

The Nix workflow downloads the desktop archives from Build in the same workflow
run and generates the flake bundle. It preloads each archive into Nix's
fixed-output store, allowing flake checks, installation, and smoke tests before
the versioned release URLs are public. Its Linux smoke checks native-addon
loading, bundled ACP adapters, dsh startup and native FFI, the packaged renderer,
the hosted daemon, startup registration through the Nix wrapper, and disabled
self-updates. The macOS job checks the app bundle layout and verifies the
preserved code signature with `codesign`.
On the disposable Ubuntu runner, the workflow allows Chromium's user namespace
sandbox through AppArmor and runs the installed package with sandboxing enabled.

`Gate` includes the DEB/RPM workflow after packaging builds. Publish also requires
Nix and AUR validation before creating the draft release or publishing the server
image. Nix reuses the configuration already compiled by Build, so it needs no
production environment access, configuration snapshot, synchronization workflow,
or additional token. Nix binary-cache publication is not configured.

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

### Experimental Nix server image

The repository-root `flake.nix` and `flake.lock` own source builds for the server
and Web application. `nix/server.nix` uses Crane to build the selected server
package with a separate Cargo dependency derivation. Its source filter keeps
workspace metadata and the backend's actual sources, including embedded SQL.
`nix/web.nix` installs the filtered `@deskfleet/web...` workspace offline from
`pnpm-lock.yaml` package integrity hashes (via `nix/import-pnpm-lock`'s pure
Nix lockfile parse and `mitm-cache` fetches), then builds the browser bundle.
Lockfile updates change those fetch inputs directly; there is no aggregate
fixed-output dependency hash to refresh and no YAML import-from-derivation. The classifier
treats the root manifest, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `patches/`,
and the Web, component, and daemon package manifests as packaging inputs so the
image build still runs when they change. Toolchain versions follow `mise.toml`
and the locked download metadata in `mise.lock`, which `nix/toolchain.nix` reads
for the Node and pnpm builds, so the classifier includes those files too.

`nix/server-image.nix` uses `dockerTools.buildLayeredImage` to include the runtime
closure, CA certificates, interactive Bash, coreutils, and independent server
and Web outputs. No Ubuntu base or apt step is involved. Docker remains the
runtime for the image smoke test; it does not build these components. Both
architectures are evaluated in every
Nix server job. PR and main-push packaging runs build and smoke-test amd64;
scheduled and manual full CI runs also build and smoke-test ARM64 natively.

This experiment uses default public frontend configuration without production
credentials or telemetry settings. The existing release image and source-map
upload flow remain owned by Build and Publish. A future release cutover must
upload maps matching the Nix-built Web output. The ordinary server binaries also
remain in their portable release archives; a binary linked against Nix store
paths cannot replace those archives directly.

Nix build outputs and container layers have separate caches. No project binary
cache is published; the runners can substitute upstream packages, while the
project's cold source build remains part of this experiment. Compare compressed
image size, cold/warm build time, and changed layer bytes before treating this
path as a release optimization. See the [server guide](../../apps/server/README.md#experimental-nix-source-image)
for local commands and lockfile-driven Web dependency installs.

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
full tier. Manual and scheduled runs use full validation. Classification uses
the hosted runner's Node and does not install a toolchain. An older runtime or
missing output keeps the full tier.

`Gate` requires successful classification and Test. Skipped Build, Nix server,
and Linux package workflows are accepted for a positively classified
documentation-only change or pull requests without packaging changes. Failed,
cancelled, or unexpectedly skipped required work fails the gate.

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

When the suites are scheduled together, daemon tests wait for Rust tests to
finish, and desktop tests wait for native compilation, Rust tests, and daemon
tests. Each suite sizes its own worker pool; hosted macOS runs hit renderer
navigation deadlines while native compilation was active. Separating Rust and
daemon tests also avoids overlapping SQLite storage
workloads while daemon IPC deadlines are active. These are ordering constraints:
running only `check:daemon` or `check:desktop` does not add the other suites.

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

`.github/actions/setup-mise` sets `MISE_ENV=ci`, which loads `mise.ci.toml`
on top of `mise.toml`. It holds the CI-only Cargo settings: no incremental
state, line-table debug info for dev and test builds, and the faster release
profile above. mise-action exports them to later steps, so plain `cargo`
steps see the same environment as `mise run`. Reproduce a CI build locally
with `mise -E ci run <task>`.

Only pushes and runs on `main` save caches. Pull requests and tags restore
main's entries through the base-branch fallback, so their own copies would
only spend the repository's 10 GB quota. Every save skips an exact hit.

| Cache | Key | Writer |
| --- | --- | --- |
| mise tools | mise-action's key: OS, mise version, `MISE_ENV`, requested tools, and `mise.lock` | Every job on `main`; Node-only jobs have their own entry |
| Cargo target | rust-cache's key: role, OS, architecture, Rust toolchain, `CARGO_*`/`RUST*` environment, and lockfiles | One job per role on `main` |
| Cargo downloads | OS, architecture, and `Cargo.lock` | Jobs without a target role |
| pnpm store | OS, architecture, and `pnpm-lock.yaml` | Every setup-build job on `main` |
| Electron | OS, architecture, and the locked Electron version | Every setup-build job on `main` |

Cargo target caches are keyed by role, not by job, so jobs that compile the
same profiles and features share one entry per OS:

| Role | Jobs | Saves |
| --- | --- | --- |
| `static` | Static checks | Yes |
| `test` | Tests on each platform; the PostgreSQL job restores Linux's entry | Tests only |
| `release` | Build | Main smoke build only |

Preflight caches only Cargo downloads. Tagged production builds restore no
target directory, so a release never reuses outputs from an unrelated build.
rust-cache saves after a failed test as well, because the build outputs are
still valid. CI does not use sccache: one Actions cache object per compilation
filled the quota and evicted the target caches.

The pnpm store and Cargo downloads fall back to the newest same-platform entry.
Installed `node_modules` directories are rebuilt from the frozen lockfile, which
also repopulates packages missing from a restored store. Keep the pnpm store
intact after installation: `pnpm store prune` can remove original package
snapshots still needed by the offline DeepSeek Harness deployment even when
the installed dependencies work. Fallback stores may retain older packages;
the cache cleanup below removes superseded Actions cache entries.
`pnpm install` does not download Electron. On a main miss, setup-build runs
`install-electron` and saves the archive on every OS, whichever job later
launches Electron.

After every run on `main`, `Prune caches` runs `scripts/ci-prune-caches.ts`.
It deletes caches saved outside `main`, then groups main's entries by key
without their input hashes and versions and keeps the newest of each group.
Superseded entries are removed instead of waiting for LRU eviction, which could
remove a live entry first. Run it locally with `GITHUB_REPOSITORY` and
`GITHUB_TOKEN` set and `--dry-run` to list what it would delete.

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
