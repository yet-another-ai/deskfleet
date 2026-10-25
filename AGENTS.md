# Agent guide

Engineering documentation lives in `agents/docs/`; `docs/` is reserved for the
product website and user manual.

## Architecture

- deskfleet manages a team's AI agents and working environments across machines.
  Read [the architecture](agents/docs/architecture.md) before changing component
  boundaries or resource ownership.
- The hierarchy is Team → Machine → Workspace → Worktree. Workspace creation
  requires ordered directory paths, with the first as default and no directory
  aliases. Its main Worktree uses those actual directories; other Worktrees are
  created and destroyed with their owning Session, never maintained separately.
  A new Session either generates its own Git worktree or works directly in the
  Workspace's directories; deleting the latter never touches those files.
  A TerminalSession can belong to a Machine, Workspace, or Worktree. Its working
  directory is a separate choice.
- Cross-machine coordination belongs to agent-facing MCP tools. Do not introduce
  a global Project abstraction spanning machines.
- The central backend is open-source Rust using Actix Web. Native capabilities
  live in Rust libraries, exposed through thin napi-rs bindings.
- The machine daemon is a TypeScript/Node.js library. Headless machines run it as
  a standalone SEA process. The Electron app hosts it in the app's main process:
  it outlives the app's windows, which close to the tray, and stops when the app
  quits. Do not spawn a separate daemon process from the app.
- ACP connects agent implementations. WebRTC carries peer data and media, with
  server-assisted signaling and TURN fallback.
- `PROTOCOL_VERSION` remains `1` until maintainers explicitly declare the first
  protocol freeze. Evolve provisional contracts in place. Do not add version-bump
  tasks or compatibility layers for earlier provisional shapes.

## Development workflow

Use the locked mise toolchain from the repository root:

```sh
mise install --locked
mise run dev
mise run check
```

Run commands in a login shell. Use PowerShell 7 (`pwsh`) on Windows. For a
focused command, use `mise exec -- cargo ...` or the appropriate mise task.
[Environment notes](agents/docs/environment.md) describe tool and skill updates;
[CI notes](agents/docs/ci.md) describe the reusable workflows and `Gate` check.

Keep application entry points and binding layers thin. Split code around feature
ownership. Review production files approaching 800 lines; split hand-authored
production files before they exceed 1,200 lines, and keep new files below 800.
Generated code, FFI declarations, and tests can have justified exceptions.

Write repository-owned Node scripts in TypeScript with erasable syntax so the
locked Node runtime can execute them directly.

Test deskfleet's behavior at the narrowest useful boundary. Avoid duplicating
upstream library tests. Run checks appropriate to the change.

Update the document that owns a decision. Create or accept an ADR only when a
maintainer requests it.

## Documentation and skills

Use English for repository documentation. Keep temporary notes and generated
output out of the documentation trees.

`apm.yml` and `apm.lock.yaml` own the installed skills in `.agents/skills/`.
These installed files belong in source control so fresh checkouts have them.
Restore them with `mise run skills:install`. Change the dependency declarations
and regenerate for updates; do not hand-edit installed skill copies.
Only `apm_modules/`, the local package download cache, is ignored.

Use the installed Rust guidance for Rust work and the other skills when their
stated triggers apply. The upstream Rust example harness is excluded from the
deskfleet Cargo workspace; it is not part of the product or its build.

`vueuse-functions` applies when assisting Vue or Nuxt work. Invoke it as
`/vueuse-functions`. Before using a VueUse API, read the matching file under
`.agents/skills/vueuse-functions/references/`. Each function is `AUTO` (use when
it fits), `EXTERNAL` (only when its extra dependency is already installed), or
`EXPLICIT_ONLY` (only when asked). Instructions in this file override those
defaults.
