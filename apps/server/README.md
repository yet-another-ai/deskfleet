# deskfleet server

The Actix Web backend initializes a persistent SeaORM resource catalog and
exposes `GET /healthz` for process liveness. Catalog HTTP operations and daemon
synchronization are not yet exposed.

The [backend implementation scope](../../agents/docs/backend.md) defines the next
release: an API-only service using PostgreSQL, OIDC, Team membership, machine
enrollment, authenticated management/signaling, synchronized Agent history, and
reversible Session archive/restore with data retention. Permanent Session
deletion is not a first-release user-facing operation.
The Vue Web frontend is hosted separately and shares UI components with Electron.
The SQLite configuration below describes the currently implemented server;
PostgreSQL support is planned, not yet available.

## Run

From the repository root:

```sh
mise run dev
```

The default listener is `127.0.0.1:8080`.

```sh
DESKFLEET_BIND_ADDR=127.0.0.1:9090 RUST_LOG=info mise run dev
```

`DESKFLEET_BIND_ADDR` accepts an IP address and port, including IPv6 addresses such
as `[::1]:8080`. Hostnames are not accepted. Invalid values fail at startup. Port
`0` requests an available port, and the startup log reports the actual address.
Actix handles shutdown signals using its standard graceful shutdown behavior.

## Database and migrations

`DATABASE_URL` defaults to `sqlite://deskfleet.db?mode=rwc`, creating a SQLite
database in the process's working directory. The root database and its journal
files are ignored by Git. Set an explicit path for persistent deployments:

```sh
DATABASE_URL=sqlite:///var/lib/deskfleet/catalog.db?mode=rwc mise run dev
```

The parent directory must already exist. `sqlite::memory:` is useful for isolated
tests. Startup opens one shared connection and applies all pending migrations
before the HTTP listener binds; database or migration failures stop startup.

The schema contains teams, machines, workspaces, worktrees, and ordered directory
bindings. Resource IDs are database-assigned signed 64-bit integers and serialize
as decimal strings in shared JSON models. Resource names need not be unique.
Foreign keys reject orphaned records and parent deletion while children remain;
deleting a worktree also deletes its directory bindings. Worktree writes are
transactional. See [catalog persistence](../../agents/docs/architecture.md#catalog-persistence)
for ownership and PostgreSQL preparation.

Manage migrations with the same `DATABASE_URL` used by the server:

```sh
mise run db:migrate
mise run db:migrate -- status
mise run db:migrate -- down
```

`down` reverts the latest migration; reverting the initial catalog migration
deletes all catalog tables and their data. The CLI is an optional feature of
`deskfleet-migration`, so it is not compiled into the server. Explicit migrations
own the schema; startup does not infer changes from entity definitions. The
layout follows the [SeaORM migration workflow](https://www.sea-ql.org/SeaORM/docs/migration/setting-up-migration/).

## Liveness

```sh
curl http://127.0.0.1:8080/healthz
```

The JSON response includes `status`, the server `version`, and `protocol_version`.
This route reports process liveness.

## Check

```sh
mise exec -- cargo test -p deskfleet-model -p deskfleet-migration -p deskfleet-store -p deskfleet-server --locked
```
