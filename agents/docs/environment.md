# Development environment

deskfleet follows [Heron's development workflow](https://github.com/minori-live/heron/blob/main/AGENTS.md):
mise owns tool versions and the task graph, APM owns repository-local skills,
and local validation uses the same tasks as CI.

## Bootstrap

Install [mise](https://mise.jdx.dev/getting-started.html), then run from the
repository root in a login shell:

```sh
mise trust
mise install --locked
```

With Docker Engine or Docker Desktop running Linux containers and Docker Compose
v2.20 or newer installed, start the local dependencies and backend:

```sh
mise run infra:up
mise -E development run dev
```

In another terminal, run `mise run web:dev` and open `http://127.0.0.1:5174/`, or
run `mise run desktop:dev`. Both clients use `http://127.0.0.1:8080` and the same
OIDC login. Sign in as `alice@example.test` with password `password`, then create
a team. `bob@example.test` has the same password and can join with an invitation
from Alice's team to exercise the ordinary member role. OIDC accounts have no
preassigned team roles. The backend creates its PostgreSQL schema on startup.

For an existing PostgreSQL/OIDC deployment, use the
[server guide](../../apps/server/README.md) and `mise run dev` without the
`development` environment.

Use PowerShell 7 (`pwsh`) on Windows. `mise exec -- <command>` runs a focused
command with the project tools even when the shell has not activated mise.

## Product website

The VitePress website and user guide live in `docs/`. Run `mise run docs:dev`
and open `http://127.0.0.1:5175/`. `mise run docs:typecheck` checks the shared
component demos; `mise run docs:build` generates `docs/.vitepress/dist/` and
validates internal links. Preview that output with `mise run docs:preview`.

The landing page follows Heron's refactored VitePress homepage at commit
`b61a783b` (v0.9.1): assembling desktop windows, a scroll-driven showcase,
staggered text reveals, and segmented installation controls. Its hero scales the
actual application into windows that fan out in depth, respond to pointer
movement, and disperse on scroll. Hero sizing reserves VitePress's navigation
height and the copy's actual height before sizing the scene. Reduced-motion
preferences show the assembled scene without animation. The showcase mounts the same
`App.vue`, routes, stores, and controls with independent browser-local sample
state. It needs no backend, agent credentials, or model calls. English and
Simplified Chinese content share those components. The sticky showcase reserves
the fixed navigation height; short viewports use normal page flow with tabs so
the application controls and explanatory text remain reachable.

`packages/components/src/theme-tokens.css` owns the product palette. Both the
application and website consume it; `color-scheme` selects the website's explicit
light/dark theme. `product-demo.css` only restores application typography and
dialog centering within VitePress. Fonts and brand assets are bundled locally.
The desktop example uses the production `DesktopView` and a browser-local WebRTC
peer streaming recorded product screens (`demo-desktop-light.png` and
`demo-desktop-dark.png`). These screenshots are media fixtures, not a separate
implementation of the application UI.

The supplied brand master lives in `packages/components/src/assets/deskfleet.png`;
`mise exec -- pnpm --filter @deskfleet/desktop icons` regenerates the application,
tray, Web favicon, and website assets from it.

## Local Docker Compose

[`compose.yaml`](../../compose.yaml) runs the supporting services; Rust, Vue,
Electron, and the machine daemon run on the host with the locked mise toolchain
for debugging and hot reload. No external identity-provider account is needed.
The images are pinned to multi-architecture digests.
PostgreSQL stays on major version 17 to preserve the development database volume;
upgrading its major version requires a separate data migration. The coturn relay
uses plain TCP and UDP; DTLS remains disabled because it is opt-in in coturn 4.18.

| Service | Host endpoint | Data lifetime |
| --- | --- | --- |
| `postgres` | `127.0.0.1:55432`, database/user `deskfleet`, password `deskfleet-dev` | Named volume |
| `postgres-test` | `127.0.0.1:55433`, database/user `deskfleet_test`, password `deskfleet-test` | Temporary memory filesystem, cleared on stop |
| `oidc` (Dex) | `http://127.0.0.1:5556/dex` | Named volume for signing keys and login state |
| `turn` (coturn) | `127.0.0.1:3478` TCP/UDP, relay ports `49160–49180` UDP | Temporary |

`infra:up` waits for all four health checks. `mise.development.toml` opts into
their connection settings with `-E development`; it leaves the base environment
and CI settings alone. The development `DATABASE_URL` is scoped to the `dev`
task, so `db:migrate` continues to target the daemon's SQLite catalog. No Vite
production URL is set by the development environment.

Dex uses authorization code flow with PKCE and signed ID tokens, through the
same backend authentication path as a hosted OIDC provider. Its registered
redirect URI is `http://127.0.0.1:8080/api/auth/callback`. The backend then returns
to the Web root (`http://127.0.0.1:5174/`) or Electron's temporary loopback callback.
Use `127.0.0.1` consistently; `localhost` is a different allowed origin/issuer.
See [Dex's configuration example](https://github.com/dexidp/dex/blob/v2.46.1/config.yaml.dist)
for the upstream configuration format.

These are public development credentials, with HTTP and a loopback-only TURN
relay. All published ports bind to `127.0.0.1`; this setup supports clients and
daemons on the same host, not LAN or hosted deployments. The API, Dex, and Web
URLs must change together when choosing different host ports, and both the
backend and coturn must use the same TURN secret.

Run the database and full remote workflow checks using the isolated test service:

```sh
mise -E development run backend:test
mise -E development run backend:smoke
mise -E development run backend:smoke-clients
mise -E development run backend:smoke-relay
```

The smoke tests start their own API and OIDC fixtures on temporary ports and
build their dependencies automatically. They can run while the development API
is running and never reset its database. `backend:smoke-relay` repeats the native,
Web, and Electron flows with TURN forced, verifying actual relay traffic. On
headless Linux, prefix the client and relay commands with `xvfb-run -a`.
For only the automated checks, `docker compose up -d --wait postgres-test turn`
starts the two services they need.

Inspect or stop the stack with:

```sh
docker compose ps
docker compose logs --tail=100
mise run infra:down
```

Stopping preserves the development PostgreSQL and Dex volumes. To clear only
test data, stop `postgres-test`, then bring that service up again with `--wait`.
`docker compose down --volumes` also deletes the development database and Dex
state; use it only when intentionally resetting the whole local environment.
The daemon's host data directory is separate and is never changed by Compose.

## Toolchain

`mise.toml` selects Rust, its components, Node.js, pnpm, APM, and supporting
development tools. Lockfile mode is enabled and `mise.lock` records the resolved
versions and available platform metadata. `Cargo.lock` owns Rust dependencies;
`pnpm-lock.yaml` owns JavaScript dependencies. Cargo's `rust-version` declares
compiler requirements; it does not select the installed toolchain.

Native media builds use locked CMake 4.4 to compile bundled Opus, plus the host C/C++
toolchain. CMake 4.2 or newer is required for the Visual Studio 18 2026 generator
on current GitHub-hosted Windows runners. Opus 0.4 uses `opusic-sys` with its
default bundled static library; its CMake 3.16 baseline works with CMake 4.
On macOS install the Xcode command-line tools. mise loads
`.config/build-env/macos.toml` to select Apple Clang for C/C++ and Rust linking,
even if Nix's compiler wrappers precede it on `PATH`. It also clears the inherited
`LIBRARY_PATH` for project commands so the addon links Apple's system libraries
instead of embedding paths to a local Nix store. These settings apply to both
`mise run` and `mise exec`; other platforms keep their existing toolchains.
On Windows install the Windows SDK and LLVM/libclang for NVENC header generation,
setting
`LIBCLANG_PATH` to LLVM's `bin` directory when it is not discovered automatically.
See [native media](media.md) for static linkage and platform support.

After changing a tool declaration, run `mise lock` and `mise install --locked`,
then include the configuration and lockfile changes together.

## Task boundaries

| Command | Purpose |
| --- | --- |
| `mise run install` | Install the pnpm workspace from the frozen lockfile |
| `mise run infra:up` / `infra:down` | Start or stop the local Compose dependencies |
| `mise run dev` | Run the Actix Web server |
| `mise -E development run dev` | Run the API with the local Compose database, OIDC, and TURN settings |
| `mise run backend:test` | Run real PostgreSQL integration tests using `TEST_DATABASE_URL` |
| `mise run backend:smoke` | Exercise OIDC, two enrolled daemons, native WebRTC, and synchronized history |
| `mise run backend:smoke-clients` | Drive the built Web and Electron clients through login and remote execution; use `xvfb-run -a` on headless Linux |
| `mise run backend:smoke-relay` | Force both backend smoke suites through the configured TURN relay |
| `mise run db:migrate` | Apply catalog migrations; append `-- status` or `-- down` for migration management |
| `mise run daemon:dev` | Build the debug addon and run the daemon from TypeScript |
| `mise run desktop:dev` | Run the Electron app with the Vite renderer server and watched main/preload bundles |
| `mise run desktop:build` | Build the Electron main, preload, and renderer bundles |
| `mise run web:dev` / `web:build` | Run or build the independent Vue Web app |
| `mise run web:typecheck` | Check the Web app and shared components |
| `mise run desktop:smoke-catalog` | Exercise local catalog forms, persistence, and directory terminals in production Electron |
| `mise run desktop:package` / `desktop:package:dir` | Package the desktop app with electron-builder as installers or an unpacked directory |
| `mise run check` | Run static checks, TypeScript and Rust tests, and debug workspace and desktop builds |
| `mise run check-fast` | Run Rust formatting, dependency usage, Clippy, and tests |
| `mise run test` | Run repository script, daemon, desktop, and Rust tests |
| `mise run build` | Build the release server and standalone SEA daemon |
| `mise run daemon:pack` | Package the daemon as a standalone SEA executable |
| `mise run daemon:smoke` | Run the SEA executable alone with no Node on PATH |
| `mise run native:debug` / `native:release` | Build the napi-rs addon and regenerate TypeScript declarations |
| `mise run format` | Apply Rust formatting |
| `mise run format-check` | Check Rust formatting |
| `mise run lint` | Check Rust dependency usage and Clippy |
| `mise run skills:install` | Restore skills from the APM lockfile |

Public tasks compose focused tasks in `mise.toml`. Independent checks can run in
parallel. Cargo operations sharing `target/` use mise's `wait_for` ordering when
they appear in the same run, avoiding repeated builds and lock contention.

The pnpm workspace contains `apps/daemon`, `apps/desktop`, `apps/web`,
`packages/client`, `packages/components`, and `crates/node`.
Root TypeScript configuration checks the daemon, native loader, and repository
scripts with TypeScript 7. The desktop package checks itself with vue-tsc, which
needs the TypeScript compiler API, so it installs TypeScript 6 under the
`typescript` name; see the [desktop guide](../../apps/desktop/README.md).
The native package's `bindings.d.ts` is generated by napi-rs and checked in; its
platform binary and application `dist/` output are build artifacts.

Build tasks install frozen workspace dependencies automatically. After changing
a package manifest, run `mise exec -- pnpm install` and include the lockfile in
the change. See the [daemon guide](../../apps/daemon/README.md) for packaging and
runtime commands.

The ACP SDK, Codex adapter, Claude Agent adapter, and Pi ACP adapter are pinned daemon
dependencies in pnpm. The SEA build embeds those adapters. Running a session
still requires the installed CLI: Codex, Claude Code, Cursor (`agent acp`),
Grok (`grok agent stdio`), or Pi (`pi --mode rpc`). Pi's official installer can
provide its required Node.js runtime; the bundled adapter does not include Pi.
Use `--binary-path` to select it and repeated `--env` options for environment
overrides. See the [agent setup](../../apps/daemon/README.md#agents-through-acp)
for initialization checks and prompt commands.

## Agent skills

APM installs `rust-skills`, `stop-that-shit`, and `stss` from the commit references
in `apm.yml`. `apm.lock.yaml` records their resolved sources and deployed files.
Both manifests and the installed `.agents/skills/` tree belong in source control.
Only the local download cache, `apm_modules/`, is ignored.

A fresh checkout already contains the skills. To restore the exact installation:

```sh
mise run skills:install
```

This uses `apm install --frozen`. To update a dependency, edit its
reference in `apm.yml`, run `mise exec -- apm install`, and review the manifest,
lockfile, and installed skill diff together. Do not edit the deployed copies by
hand.

The Rust skill includes an upstream example crate and its own toolchain file.
Those files are preserved as dependency content. The example crate is excluded
from the deskfleet Cargo workspace, and the static checks verify that boundary;
deskfleet builds use the root mise toolchain.
