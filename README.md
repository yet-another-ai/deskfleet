<img src="packages/components/src/assets/deskfleet.png" width="96" height="96" alt="deskfleet logo" />

# deskfleet

deskfleet manages AI agents and their working environments across a team's computers.

The system connects agents through ACP, stores session history on a
central server, and uses WebRTC for terminal and desktop access. Workspaces
contain worktrees that group directories and agent sessions. Git state is shown
alongside sessions, and agents coordinate across machines through MCP tools.

The project is a Rust and TypeScript monorepo. The central backend uses Actix Web.
The TypeScript daemon calls Rust through napi-rs. Headless machines run it as a
Node.js Single Executable Application (SEA); the Electron app hosts it in its
main process. The Electron client uses Vue.

The API-only backend uses PostgreSQL for OIDC accounts, teams, machine enrollment,
resource catalogs, and synchronized Agent history. Daemons retain their local
SQLite catalogs and execute Codex CLI, Claude Code, Cursor CLI, and Grok CLI
sessions over ACP. The Web and Electron clients share Vue components, manage
resources through the backend, and use authenticated WebRTC for Agent, Git,
terminal, and desktop traffic.
Sessions can be archived and restored while preserving their data.

## Rust workspace

| Package | Location | Responsibility |
| --- | --- | --- |
| `deskfleet-model` | `crates/model` | Typed resource IDs, the machine/workspace/worktree hierarchy, directory bindings, and session associations |
| `deskfleet-store` | `crates/store` | SeaORM entities and transactional workspace/worktree catalog persistence |
| `deskfleet-control-store` | `crates/control-store` | PostgreSQL identities, teams, machines, authorization, and central replicas |
| `deskfleet-migration` | `crates/migration` | Catalog schema migrations and an optional CLI |
| `deskfleet-protocol` | `crates/protocol` | Shared wire contracts and protocol version |
| `deskfleet-native` | `crates/native` | Platform capabilities independent of Node.js and the server |
| `deskfleet-node` | `crates/node` | Thin napi-rs bindings over native capabilities and local catalog persistence |
| `deskfleet-server` | `apps/server` | Actix Web control-plane backend |

Install [mise](https://mise.jdx.dev/getting-started.html) and Docker with Docker
Compose. With Docker running, run from the repository root:

```sh
mise trust
mise install --locked
mise run infra:up
mise -E development run dev
```

Docker Compose provides local PostgreSQL, OIDC, and TURN services. In another
terminal, run `mise run web:dev` and open `http://127.0.0.1:5174/`, or run
`mise run desktop:dev`. Sign in with `alice@example.test` / `password` and create
a team. See the [development guide](agents/docs/environment.md#local-docker-compose)
for the second test account, separate test database, relay checks, and cleanup.

`mise.toml` manages tool versions. `mise.lock`, `Cargo.lock`, and `pnpm-lock.yaml`
lock tools, Rust dependencies, and JavaScript dependencies respectively.

The server listens on `127.0.0.1:8080` by default:

```sh
curl http://127.0.0.1:8080/healthz
```

`DESKFLEET_BIND_ADDR` sets the listener's IP and port, and `RUST_LOG` configures
logging. See [server configuration](apps/server/README.md) and
[native binding development](crates/node/README.md).

## Daemon

The pnpm workspace contains `@deskfleet/daemon` in `apps/daemon` and
`@deskfleet/native` in `crates/node`. Start the daemon from source with:

```sh
mise run daemon:dev
```

It runs in the foreground and prints its loopback health address. Build and test
the standalone executable with:

```sh
mise run daemon:pack
mise run daemon:smoke
```

The executable is `apps/daemon/dist/deskfleet-daemon` (`.exe` on Windows).
It also runs single-turn Codex or Claude Code sessions using the installed CLI and
an embedded ACP adapter. See the [daemon guide](apps/daemon/README.md) for agent
configuration, CLI options, and platform support.

## Desktop app

`@deskfleet/desktop` in `apps/desktop` is the Electron client. Start it with hot
reload using:

```sh
mise run desktop:dev
```

Closing the window keeps the app in the system tray. Use the tray menu to quit;
the daemon keeps running. See the [desktop guide](apps/desktop/README.md) for
development and packaging details.

## Product website

The VitePress website in `docs/` includes English and Simplified Chinese pages
and interactive examples built from the application's shared Vue components.
Start it with `mise run docs:dev` and open `http://127.0.0.1:5175/`.
Build the static site with `mise run docs:build`; the output is
`docs/.vitepress/dist/`. The demos run with browser-local sample data.

## Checks

Run the workspace checks with:

```sh
mise run check
```

Local checks and CI share the task graph in `mise.toml`. Use `mise exec -- cargo ...`
for individual Cargo commands without relying on shell activation. See the
[development environment](agents/docs/environment.md) for focused commands and
[CI workflow](agents/docs/ci.md) for platform validation and build artifacts.

Repository-local agent skills are managed by APM. The installed `rust-skills`,
`stop-that-shit`, `stss`, and `vueuse-functions` skills live in `.agents/skills/`
and are included in the repository together with `apm.yml` and `apm.lock.yaml`.
Restore them with `mise run skills:install`; only the `apm_modules/` download
cache is ignored. `vueuse-functions` is the official VueUse skill; invoke it as
`/vueuse-functions` when working on Vue or Nuxt.

## Design

- [Architecture](agents/docs/architecture.md): component boundaries, data ownership,
  protocols, deployment, and implementation milestones.
- [Agent guide](AGENTS.md): repository conventions and engineering workflow.

## License

The backend and deskfleet source use the [Apache-2.0 license](LICENSE). Vendored
skills retain their upstream licensing.
