# Development environment

DeskFleet follows [Heron's development workflow](https://github.com/minori-live/heron/blob/main/AGENTS.md):
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
v2.20 or newer installed, start the local dependencies, API, and Web client:

```sh
mise run infra:up
mise run dev:seed
mise -E development run dev
```

The `dev` task starts the API and Web client together. Open `http://localhost:5174/`,
or run `mise run desktop:dev` in another terminal. Electron also needs the Web
service for its browser login, so keep `dev` running. Both clients use
`http://localhost:8080` and the same
owned account service. Choose Register, enter an email, and open the verification
link in `.local/mail/` to set your name and password. Register a second account
and invite its verified email to exercise the member role. Ordinary registration
does not assign a Team or Site Admin role. The backend creates its schema on startup.

`mise run dev:seed` is an optional shortcut that targets the local Compose
development database and creates a verified Site Admin:

- Email: `admin@deskfleet.test`
- Password: `deskfleet-dev-password`

Sign in directly with those credentials; no verification email or separate
administrator grant is needed. Create a Team from onboarding when needed.
The command applies the schema, runs without starting HTTP or sending mail, and
is only available in debug builds. Repeated runs leave an existing account's
password, profile, disablement, and permissions unchanged. It never runs
automatically with `dev` and never resets existing data.

For an existing PostgreSQL deployment during development, use the
[server guide](../../apps/server/README.md) and `mise run backend:dev` without the
`development` environment. Running that API outside the local Compose stack is
the [self-hosted backend guide](self-hosted.md).

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
dialog layout within VitePress. Fonts and brand assets are bundled locally.
Shared UI controls live in `packages/components/src/components/common/`:
`UiButton` and `IconButton` own action sizes and states; `UiSelect`, `UiCheckbox`,
`UiSwitch`, `UiNumberField`, `UiTimeField`, and `UiDialog` adapt Reka UI primitives
to application models and UnoCSS tokens. Menus, tabs, popovers, and disclosures
use Reka primitives with the same tokens. Keep native text inputs and textareas;
schema-driven numeric answers retain native validation for arbitrary decimal
constraints. Schedule times cross the component boundary as minute-precision
`HH:mm` strings, with the IANA time zone selected separately. Popups inside the
remote desktop fullscreen surface must portal into that surface. Tests should
exercise visible controls and query portaled content through the document;
primitive behavior tests use real portals and cover focus and form validation.
Top-level application and authentication mounts install `nativeDragPolicy` from
`packages/components/src/plugins/native-drag.ts`. It cancels native link/image
`dragstart` events in application chrome, including teleported controls. Content
inside `.ui-markdown` or `.select-text`, and explicit `draggable="true"` sources,
retain native dragging. Keep incoming file drops and pointer-based interactions
separate from this policy; nested machine applications inherit the document listener.
`UiButton`, `IconButton`, and `UiTooltip` deliberately use normal Vue scripts:
Reka's `useForwardExpose` and `as-child` composition require a VDOM component
instance and VNode slots. Vapor callers should use `:as="IconButton"` for menu
and popover triggers instead of `as-child`. The rest of the application retains
Vapor compilation. The Electron agent smoke test covers the compiled trigger
attributes, keyboard behavior, and tooltip to catch interop regressions.
The desktop example uses the production `DesktopView` and a browser-local WebRTC
peer streaming recorded product screens (`demo-desktop-light.png` and
`demo-desktop-dark.png`). These screenshots are media fixtures, not a separate
implementation of the application UI.

Use **DeskFleet** for the product's display name; package names, commands, URLs,
and other technical identifiers remain lowercase. The supplied Arctic fox brand
master lives in `packages/components/src/assets/deskfleet.png`;
`mise exec -- pnpm --filter @deskfleet/desktop icons` regenerates the application,
tray, Web favicon, and website assets from it.

## Local Docker Compose

[`compose.yaml`](../../compose.yaml) runs the supporting services; Rust, Vue,
Electron, and the machine daemon run on the host with the locked mise toolchain
for debugging and hot reload. No external identity-provider account is needed.
The images are pinned to multi-architecture digests. PostgreSQL uses 18.6, the
[latest stable release](https://www.postgresql.org/support/versioning/) verified
on October 25, 2026. The [official PostgreSQL 18 image](https://hub.docker.com/_/postgres#pgdata)
stores `PGDATA` at `/var/lib/postgresql/18/docker`, so both database services
mount storage at `/var/lib/postgresql`. The coturn relay uses plain TCP and UDP;
DTLS remains disabled because it is opt-in in coturn 4.18.
A single [Redis 8.10.3](https://github.com/redis/redis/releases/tag/8.10.3)
instance carries TURN usage notifications.

| Service | Host endpoint | Data lifetime |
| --- | --- | --- |
| `postgres` | `127.0.0.1:55432`, database/user `deskfleet`, password `deskfleet-dev` | Named volume `postgres-18-data` |
| `postgres-test` | `127.0.0.1:55433`, database/user `deskfleet_test`, password `deskfleet-test` | Temporary memory filesystem, cleared on stop |
| `redis` | `127.0.0.1:56379`, no password | Temporary memory filesystem, persistence disabled |
| `turn` (coturn) | `127.0.0.1:3478` TCP/UDP, relay ports `49160–49180` UDP | Temporary |

`infra:up` waits for all four health checks. `mise.development.toml` opts into
their connection settings with `-E development`; it leaves the base environment
and CI settings alone. The development `DATABASE_URL` is scoped to the `backend:dev`
task, so `db:migrate` continues to target the daemon's SQLite catalog. No Vite
production URL is set by the development environment. The backend task also enables
[Team TURN usage collection](self-hosted.md#team-turn-usage-collection) through
the local Redis instance.

The backend owns registration, password recovery and Passkeys. Local mail is
written as restricted `.eml` files to `.local/mail/`; use their one-use links in
the trusted Web application. These messages are ignored by Git. No production
mail relay is contacted by the local fixture. Use `localhost` consistently for Web and API origins: Passkeys require a DNS
hostname. Services remain bound to loopback; Vite uses `localhost`.

These are public development credentials, with HTTP and a loopback-only coturn
instance advertised as both STUN (`DESKFLEET_STUN_URLS`) and TURN
(`DESKFLEET_TURN_URLS`). All published ports bind to `127.0.0.1`; this setup
supports clients and daemons on the same host, not LAN or hosted deployments.
The API and Web URLs must change together when choosing different host
ports, and both the backend and coturn must use the same TURN secret.

Run the database and full remote workflow checks using the isolated test service:

```sh
mise -E development run backend:test
mise -E development run backend:smoke
mise -E development run backend:smoke-clients
mise -E development run backend:smoke-relay
```

The smoke tests start their own API and local mail fixtures on temporary ports and
build their dependencies automatically. They can run while the development API
is running and never reset its database. `backend:smoke-relay` repeats the native,
Web, and Electron flows with TURN forced, verifying actual relay traffic. On
headless Linux, prefix the client and relay commands with `xvfb-run -a`.
For only the automated checks,
`docker compose up -d --wait postgres-test redis turn` starts the services they
need. `backend:test` uses `TEST_DATABASE_URL` and `TEST_REDIS_URL`.

Inspect or stop the stack with:

```sh
docker compose ps
docker compose logs --tail=100
mise run infra:down
```

Stopping preserves the development PostgreSQL volume. To clear only
test data, stop `postgres-test`, then bring that service up again with `--wait`.
The daemon's host data directory is separate and is never changed by Compose.

### Fresh development database and reset

The owned-account change replaces the provisional OIDC schema in place. Rebuild
any development database created before this change using the reset below; there
is no migration of old accounts, memberships, tokens, or billing state. Register
again and enroll machines into the new Team. The reset does not delete local
machine directories or working files.

The PostgreSQL 18 upgrade uses a new `postgres-18-data` volume. On the first
`mise run infra:up`, it initializes an empty database; the next
`mise -E development run dev` applies the backend schema. Sign in and create a
new team to resume development. Local development data is disposable, so this
upgrade does not migrate rows from PostgreSQL 17. The previous `postgres-data`
volume is left untouched and must not be attached to the PostgreSQL 18 service.

To reset only the PostgreSQL 18 development database, stop the development API
first, then run these commands from the repository root with the default
`deskfleet-dev` Compose project:

```sh
docker compose stop postgres
docker compose rm -f postgres
docker volume rm deskfleet-dev_postgres-18-data
docker compose up -d --wait postgres
mise -E development run dev
```

This deletes only that development database's rows; other volumes remain intact. If using a custom Compose project name, use its matching
PostgreSQL volume name instead. Managed production databases follow their own
upgrade process; these commands apply only to the local development stack.

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
| `mise run dev` | Run the API and Web client, including Electron's browser login pages |
| `mise -E development run dev` | Run both services with the local Compose database, local mail, and TURN settings |
| `mise run dev:seed` | Create the default verified Site Admin in the local Compose development database; preserve existing accounts |
| `mise run backend:dev` | Run only the Actix Web API; add `-E development` for local Compose settings |
| `mise run backend:test` | Run real PostgreSQL and Redis integration tests using `TEST_DATABASE_URL` and `TEST_REDIS_URL` |
| `mise run backend:smoke` | Exercise owned authentication, two enrolled daemons, native WebRTC, and synchronized history |
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
| `mise run ci:build` | Build all release bundles with one shared Rust workspace build |
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

The full release build uses napi to compile the Cargo workspace once with an
explicit host target, then emit the addon and its TypeScript declarations.
`build` and the CI desktop bundle share this preparation task. The server is in
`target/<host-triple>/release/`; obtain the triple with
`mise exec -- rustc --print host-tuple`. Standalone `native:release`,
`daemon:pack`, and `desktop:release-build` keep their addon-only Rust build.

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

## Dependency updates

[`renovate.json`](../../renovate.json) follows
[Heron's grouped update policy](https://github.com/minori-live/heron/blob/main/renovate.json):
weekly dependency updates, monthly GitHub Actions updates, at most two open PRs,
and a separate lockfile maintenance group. Majors and minors share the update
group and require maintainer review; automerge is disabled. npm releases age for
three days before ordinary updates. Lockfile maintenance delegates resolution to
Cargo and pnpm and does not apply that release-age filter.

Built-in managers cover Cargo, pnpm, Compose images, and GitHub Actions, including
the mise and sccache action inputs. Keep Renovate's Node, pnpm, and Rust `constraints`
aligned with `mise.toml` so lockfile generation uses the repository's tools.
Node types stay on 24 because the standalone daemon's SEA build targets Node 24.
PostgreSQL major updates use a separate group and require Dependency Dashboard
approval so the development volume migration or reset can be reviewed explicitly.

The patched `@agentclientprotocol/codex-acp` and `pi-acp` dependencies are updated
manually: review or rebase their patches, update the version-specific
`patchedDependencies` entries, regenerate `pnpm-lock.yaml`, and run the affected
adapter tests and daemon packaging smoke checks. Other ACP dependencies remain
eligible for Renovate updates. Preserve the TypeScript 6 npm aliases used by
vue-tsc when reviewing the grouped PR.

Toolchain and APM updates remain manual. Renovate supports mise lockfiles, but
[lock regeneration requires host support](https://docs.renovatebot.com/modules/manager/mise/#trust-model-for-lock-file-updates)
that repository configuration cannot grant. Enable the mise rule only after the
host can refresh `mise.lock`, and review Node runtime/SEA target changes together.
APM updates must include the installed skill tree; Renovate ignores that tree
and leaves the pinned sources to the workflow below.

Validate configuration-only edits from the repository root with the official
validator; this does not update project dependencies:

```sh
mise exec -- pnpm dlx --package=renovate renovate-config-validator --strict
```

The Renovate GitHub App must have access to this repository, and the configuration
must be on the default branch before hosted updates can run. An organization
owner can select `yet-another-ai/deskfleet` in the existing Renovate installation,
or install [Renovate](https://github.com/apps/renovate) for that repository.

## Agent skills

APM installs `rust-skills`, `stop-that-shit`, `stss`, `i-have-adhd`,
`create-pr-with-evidence`, and `vueuse-functions` from the commit references in
`apm.yml`. `apm.lock.yaml` records their resolved sources and deployed files.
Both manifests and the installed `.agents/skills/` tree belong in source control.
Only the local download cache, `apm_modules/`, is ignored.

`vueuse-functions` is the official VueUse agent skill from `vueuse/skills`, pinned
to that single skill. Cursor loads `.agents/skills/`, and the skill can be invoked
as `/vueuse-functions`. `AGENTS.md` states when to apply it. To update it, change
the `vueuse/skills` `ref` and keep `skills` limited to `vueuse-functions`.

`i-have-adhd` comes from `ayghri/i-have-adhd` (`skills/i-have-adhd`) and deploys
to `.agents/skills/i-have-adhd/`. Invoke it as `/i-have-adhd`.
`create-pr-with-evidence` comes from `luoling8192/create-pr-with-evidence-skill`
and deploys to `.agents/skills/create-pr-with-evidence-skill/`. Invoke it as
`/create-pr-with-evidence`. `AGENTS.md` states when to apply each skill.

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
from the DeskFleet Cargo workspace, and the static checks verify that boundary;
DeskFleet builds use the root mise toolchain.
