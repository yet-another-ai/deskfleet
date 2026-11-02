/**
 * Setup spans grant issuance, SDP exchange, and ICE traversal. Mobile NAT
 * traversal regularly takes several seconds, so a short deadline aborts peers
 * that would still connect.
 */
export const PEER_SETUP_TIMEOUT_MS = 45_000

/** `disconnected` is transient during network switches and app suspension. */
export const PEER_DISCONNECT_GRACE_MS = 10_000

export interface PeerDisconnectGuard {
  /** Feed peer connection states; only a sustained `disconnected` fails. */
  update(state: string): void
  /** Stop a pending failure when the peer is deliberately replaced or closed. */
  clear(): void
}

/** A `disconnected` peer can recover when the network returns; `failed` cannot. */
export function createPeerDisconnectGuard(
  failed: () => void,
  graceMs = PEER_DISCONNECT_GRACE_MS,
): PeerDisconnectGuard {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    update(state) {
      if (state.toLowerCase() === "disconnected") {
        timer ??= setTimeout(() => {
          timer = undefined
          failed()
        }, graceMs)
        return
      }
      clearTimeout(timer)
      timer = undefined
    },
    clear() {
      clearTimeout(timer)
      timer = undefined
    },
  }
}
