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
Configure its `DESKFLEET_STATSIG_SERVER_KEY` and `DESKFLEET_STATSIG_ENVIRONMENT`
(default `production`). In that Statsig environment, enable the feature gate
`super_agent` for the intended accounts or Teams. The feature defaults to off,
including on self-hosted installations.
For the repository's local setup, start the dependencies with `mise run infra:up`,
then run `mise -E development run backend:dev`. For a custom database, set the
server's `DATABASE_URL` and use `mise run backend:dev`. Keep eve on the private
application network. Direct public traffic to the DeskFleet API. The package
disables built-in execution tools. Its model calls use the operator's credential.

In Site administration, open **Plan quotas** and set **Monthly credits** for
each hosted plan. On the same page, set the site-wide **credits per token** for
uncached input, output, cache reads and cache writes. The rates default to 1
and apply when a usage event is first recorded. Existing charges retain their
original value. During a rolling upgrade, set custom rates after all API
replicas use credits for admission. Changes to a plan's allowance apply to
existing Teams on their next request. The initial hosted allowance is zero. Select
unlimited to allow new work without a credit cap. Self-hosted deployments can
use their own model account with unlimited credits.

## Team API

Team members in the rollout can open **Super Agent** from the sidebar in Web
or Desktop, including before connecting their first Machine. Sending the first
message starts a conversation. The conversation list reopens the Team's saved
history. Reaching the monthly credit allowance pauses new messages and keeps history
available to members in the rollout.

All routes are relative to `/api/teams/{teamId}/super-agent` and use the
existing DeskFleet account authentication. Writes take a client-generated
UUID as `operationId`. Reuse it when retrying the same operation.
If a concurrent create returns HTTP 409 while the first is running, retry
with that UUID to get the Session. Each Team member can use the Team's allowance.

| Method and path | Input or result |
| --- | --- |
| GET `/availability` | Read the boolean `enabled` for the authenticated account and selected Team. |
| GET `/sessions` | List this Team's conversations by most recent activity, with `sessionId`, the first message's short `title` when available, and `lastActiveAt` in UTC milliseconds. |
| POST `/sessions` | Send `{"operationId":"<uuid>"}` to create an empty Session and receive `{sessionId}`. Include `message` to deliver the first message and receive `{sessionId, deliveryId}`. |
| POST `/sessions/{sessionId}/messages` | Send `operationId` and `message` to receive `{sessionId, deliveryId}`. |
| GET `/sessions/{sessionId}/stream?startIndex=0` | Read stored eve NDJSON through the current tail. Resume at the next stored line. |
| GET `/usage` | Read the effective plan, billing period, credit allowance (`includedCredits`, an integer or `null` for unlimited), credits charged (`usedCredits`, a decimal string), raw model tokens (`usedTokens`), runtime availability and admission decision. `includedTokens` is the legacy name for the allowance. |

Both writes accept a plain string (including Markdown) or an ordered array of
1–64 text and file parts. A file can be the entire message. This request opens
a Session with a screenshot.

```json
{
  "operationId": "ad6df494-c85c-47ad-80ff-c035da204365",
  "message": [
    { "type": "text", "text": "What changed in this screen?" },
    {
      "type": "file",
      "mediaType": "image/png",
      "filename": "screen.png",
      "data": "https://example.com/screens/screen.png"
    }
  ]
}
```

`filename` is optional. `data` can also contain base64 bytes or a data URL. The
gateway accepts up to 35 MiB of JSON per request. Eve applies its upload
policy (25 MiB per file by default). A delivery receipt confirms that Eve
accepted the message. On a retry, send the same operation ID with the same
parts in the same order. The server binds the Session to the Team before
delivering the first message, including when resuming an interrupted create.

When rollout is disabled, the other routes return HTTP 404 with code
`super_agent_disabled`. The usage collector continues settling accepted work.

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
