# Continuous integration

deskfleet follows [Heron's CI structure](https://github.com/minori-live/heron/blob/main/agents/docs/ci.md):
one orchestrator, reusable Test and Build workflows, a shared setup action, and
a stable `Gate` result for branch protection.

## Workflow ownership

- `.github/workflows/ci.yml` handles pull requests, pushes to `main`, and manual
  runs. It classifies the changed files with the hosted runner's Node, calls
  Test and Build, and combines their results in `Gate`. Configure `Gate` under
  the `CI` workflow as the required status check in repository branch protection.
  Successful runs on `main` then deploy the product website to GitHub Pages.
- `.github/workflows/test.yml` runs static checks and the desktop/Web/website builds
  once on Linux with `mise run ci:check:static`, plus Rust, daemon, and desktop
  tests on Linux, macOS, and Windows with `mise run test`. It supports reusable
  calls and manual runs. A separate Linux job runs real PostgreSQL integration
  tests and the OIDC/two-daemon remote workflow against the same pinned PostgreSQL
  18.6 image as local development, both directly and with relay-only peers through
  an isolated coturn container. It also validates the development Compose configuration.
  The same job drives the built Web and Electron clients under Xvfb through
  actual login, remote execution, archive/restore, and offline history flows.
  It installs Electron's Linux sandbox helper with root ownership and mode 4755
  before launching the clients.
- `.github/workflows/build.yml` builds release artifacts using
  `mise run build ::: desktop:release-build`, then packages Electron installers.
  Pull requests use a Linux x64 smoke build; main and manual runs use the full
  platform matrix. Packaging keeps Cargo's parallel release codegen: 16 units,
  LTO off, no debug info, and stripped symbols. Each target packages and verifies
  the standalone SEA daemon.
  The same matrix packages Electron installers and smoke-tests the backend
  container on each native Linux runner. macOS signing is enabled only by the
  Publish caller. It supports reusable calls and manual runs.
- `.github/workflows/publish.yml` validates `v*` tags, calls Test and Build, then
  creates a draft GitHub Release and pushes the backend image to GHCR after
  both workflows succeed.
- `.github/actions/setup-build/action.yml` installs locked tools and dependencies
  and configures shared caches for both reusable workflows.

The build matrix covers Linux x64/arm64, macOS arm64, and Windows x64. Each archive
contains `deskfleet-server` and `deskfleet-daemon` (`.exe` on Windows).
Separate desktop artifacts contain macOS arm64 DMG/ZIP, Windows x64 NSIS, and
Linux x64/arm64 AppImage installers. PRs exercise packaging on Linux x64.
The Linux x64 job also uploads `deskfleet-web` with the static Vue application.
Its default API origin is the hosting origin; deployments with a separate API
origin build with `VITE_DESKFLEET_SERVER_URL` as described in the Web guide.

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
platform matrix and mandatory macOS signing/notarization. It waits for both
before publishing. The Build workflow keeps read-only repository access;
only the release job receives `contents: write`, and only the image job receives
`packages: write`.

Configure these GitHub Actions repository secrets before the first tag:

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

Each tag produces a **draft** GitHub Release containing the five desktop
installers and four server/daemon archives. Review its generated notes and
assets, then publish it in GitHub. Prerelease tags create prerelease drafts.
Reruns can replace assets on a draft; they refuse to modify an already published
release. There is no client auto-updater in this pipeline.

The website reads GitHub's public `releases/latest` API in the browser and selects
the matching published stable release asset for the chosen platform and
architecture. Publishing a stable release makes it discoverable without another
Pages build. Drafts and prereleases do not replace the website's stable downloads;
failed requests and unavailable assets retain a link to GitHub Releases.

The same successful tag build pushes
`ghcr.io/yet-another-ai/deskfleet-server:<version>` as one Linux amd64/arm64 image.
Stable tags also update `:latest`; prerelease tags publish only their version.
This image push happens on the tag build, independently of the later manual
publication of the draft desktop release. It uses `GITHUB_TOKEN`, so no registry
password secret is needed. After the first push, set the GHCR package visibility
to public if anonymous image pulls are required; repository visibility alone does
not make a new package public. See the [server guide](../../apps/server/README.md)
for configuration and a container run example.

The image reuses the native Linux server binaries from Build. Each Linux runner
builds that runtime image, starts it against a disposable PostgreSQL container,
checks `/healthz`, and verifies graceful shutdown before uploading its archive.
It does not compile the Rust server again inside Docker.

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

When both suites are scheduled, daemon tests wait for Rust tests to finish.
Both create many SQLite catalogs; separating them avoids overlapping storage
workloads while daemon IPC deadlines are active. Running only `check:daemon`
does not add the Rust test suite.

Catalog behavior tests use independent in-memory SQLite databases with the same
migrations, foreign keys, and transaction logic as file catalogs. Agent Session
and runtime configuration tests keep that database open when rebuilding the
service; their Git repositories and worktrees still use temporary directories.
Local control and desktop permission behavior tests also inject in-memory
catalogs, while discovery records and terminal files still exercise the
filesystem. This keeps SQLite file creation and migrations out of their timeout
budgets.
Tests that verify catalog or machine registration persistence across a daemon
restart continue to use temporary database files. The provider control restart
test uses a fresh in-memory catalog for each daemon because its persisted state
is `agent-providers.json`; it still checks that file and reloads the providers
through authenticated IPC after restart. Select the in-memory catalog explicitly
in each fixture rather than switching all CI databases through an environment
variable.

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

All jobs use sccache 0.18.0 through the pinned `sccache-action` release and share
its GitHub Actions cache namespace. The tool version stays pinned because it
participates in that cache version. Main and tag runs can write that cache;
pull requests and other branches read it. A miss compiles normally. Service
errors are written to a runner log and `SCCACHE_LOG` is `warn`. Dependency and
tool caches follow the same producer policy, with Cargo target caches saved
from main only.

`mise run ci:report:sccache` reports cache hit, miss, write, and error counters.

Heron's Nix, coverage upload, Playwright, plug-in SDK, signing, and symbol-upload
jobs are not part of this workflow. Deskfleet keeps the orchestrator, the reusable
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
