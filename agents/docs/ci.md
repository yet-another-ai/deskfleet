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
  tests and the OIDC/two-daemon remote workflow against a PostgreSQL 17 service,
  both directly and with relay-only peers through an isolated coturn container.
  The same job drives the built Web and Electron clients under Xvfb through
  actual login, remote execution, archive/restore, and offline history flows.
  It installs Electron's Linux sandbox helper with root ownership and mode 4755
  before launching the clients.
- `.github/workflows/build.yml` builds release artifacts using `mise run build`.
  Pull requests use a Linux x64 smoke build; main and manual runs use the full
  platform matrix. Packaging keeps Cargo's parallel release codegen: 16 units,
  LTO off, no debug info, and stripped symbols. Each target packages and verifies
  the standalone SEA daemon.
  It supports reusable calls and manual runs.
- `.github/actions/setup-build/action.yml` installs locked tools and dependencies
  and configures shared caches for both reusable workflows.

The build matrix covers Linux x64/arm64, macOS arm64, and Windows x64. Each archive
contains `deskfleet-server` and `deskfleet-daemon` (`.exe` on Windows).
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
