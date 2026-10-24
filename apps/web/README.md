# deskfleet web

The independently deployed Vue application uses the same pages, components,
conversation rendering, Git panels, terminal surfaces, and settings as Electron.
`packages/components` owns that UI; `packages/client` owns the injected platform
interfaces and the HTTPS/WebSocket adapter. The Rust server exposes APIs only.

From the repository root:

```sh
mise exec -- pnpm --filter @deskfleet/web dev
mise exec -- pnpm --filter @deskfleet/web typecheck
mise exec -- pnpm --filter @deskfleet/web build
```

Vite listens at `http://127.0.0.1:5174`. The development API defaults to
`http://127.0.0.1:8080`. Set `VITE_DESKFLEET_SERVER_URL` at build time for a
separately hosted API; production otherwise uses the page's origin. Deploy
`dist/` on a static host. Configure the backend's allowed CORS origins and OIDC
return URLs to include the application's origin and exact entry URL.

Sign in through the configured OIDC provider, select a team and a machine, and
use its synchronized resource catalog. An administrator can create a team,
manage members, generate an invitation code, and enroll a headless machine.
The enrollment dialog accepts the identity reported by `deskfleet-daemon status`
and displays a credential for import through the daemon's enrollment command.
That credential is displayed only in the dialog and is not saved by the client.

The browser keeps its application login in session storage. The OIDC callback
code is exchanged together with the verifier saved for that login attempt, then
removed from the address. Electron instead holds account traffic and encrypted
credentials in its main process and opens the system browser for OIDC.

Management operations use authenticated HTTP. Agent commands, terminal I/O, and
Git reads use WebRTC after the backend authorizes the target peer and supplies
STUN/TURN configuration. Signaling loss alone leaves an established peer running;
revocation or authorization expiry closes it. Reconnecting creates a new grant.
Machine selection replaces the target's application scope, so equal local IDs
from different daemon databases cannot share cached state.

When a machine is offline, the application reads synchronized conversation
history from the backend, including its completeness watermark. Live operations
remain unavailable. Archiving a Session retains its history and working context;
restoring it does not start execution. There is no user-facing Session deletion.

Run shared UI and transport tests with
`mise exec -- pnpm --filter @deskfleet/desktop test`.
