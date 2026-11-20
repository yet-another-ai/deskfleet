# DeskFleet Super Agent

This package runs the cloud coordinator as a private eve service. It keeps
conversations in eve's PostgreSQL Workflow world. The DeskFleet API handles
Team authorization, saves operation receipts and meters tokens. Each cloud
Session belongs to one Team.

## Run locally

Use the locked mise toolchain from the repository root. Install the workspace
with `mise run install`. Supply `WORKFLOW_POSTGRES_URL` for the eve workflow
database. The database role needs permission to bootstrap the workflow schema.
Configure the eve process with `AI_GATEWAY_API_KEY` and
`DESKFLEET_SUPER_AGENT_SECRET`. Set the same private bearer secret on the API.
Choose the model with `DESKFLEET_SUPER_AGENT_MODEL` in the runtime environment.

```sh
mise exec -- pnpm --filter @deskfleet/super-agent db:setup
mise exec -- pnpm --filter @deskfleet/super-agent build
mise exec -- pnpm --filter @deskfleet/super-agent start --host 127.0.0.1 --port 3100
```

Set `DESKFLEET_SUPER_AGENT_URL=http://127.0.0.1:3100` on the Rust server.
For the repository's local setup, start the dependencies with `mise run infra:up`,
then run `mise -E development run backend:dev`. For a custom database, set the
server's `DATABASE_URL` and use `mise run backend:dev`. Keep eve on the private
application network. Direct public traffic to the DeskFleet API. The package
disables built-in execution tools. Its model calls use the operator's credential.

Hosted deployments can configure monthly included tokens with
`DESKFLEET_SUPER_AGENT_GO_TOKENS`, `DESKFLEET_SUPER_AGENT_PRO_TOKENS`,
`DESKFLEET_SUPER_AGENT_ENTERPRISE_TOKENS` and
`DESKFLEET_SUPER_AGENT_FREE_TOKENS`. An unset or zero hosted allowance
disables new work for that plan. Self-hosted deployments with a configured
runtime can use their own model account without a DeskFleet allowance.

## Team API

All routes are relative to `/api/teams/{teamId}/super-agent` and use the
existing DeskFleet account authentication. Writes take a client-generated
UUID as `operationId`. Reuse it when retrying the same operation.
If a concurrent create returns HTTP 409 while the first is running, retry
with that UUID to get the Session. Each Team member can use the Team's allowance.

| Method and path | Input or result |
| --- | --- |
| POST `/sessions` | Send `{"operationId":"<uuid>"}` to create a Session and receive its `sessionId`. |
| POST `/sessions/{sessionId}/messages` | Send `{"operationId":"<uuid>","message":"Plan the release"}` to receive a delivery receipt. |
| GET `/sessions/{sessionId}/stream?startIndex=0` | Read stored eve NDJSON through the current tail. Resume at the next stored line. |
| GET `/usage` | Read the effective plan, billing period, configured allowance, recorded tokens, runtime availability and admission decision. |

The stream exposes `x-eve-stream-version` and `x-eve-stream-tail-index` to
clients, including browsers on configured Web origins. The tail index is the
zero-based position of the last stored line, or `-1` for an empty stream.

The API polls eve independently of the viewer and records usage at its source
timestamp. At the monthly allowance, new requests receive HTTP 429. Work
accepted before usage arrives can take the recorded total above the allowance.
A retry can retrieve the saved receipt for an already accepted operation.

Self-hosted eve replays sessions on the same eve version. A framework version
change can strand older conversations even when their history remains readable.
Review [eve's self-hosted upgrade procedure](https://github.com/vercel/eve/blob/main/docs/guides/deployment/self-hosted-operations.md#upgrade-a-self-hosted-agent)
before changing the pinned runtime.
