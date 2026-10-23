import type { Socket } from "node:net"

/** Flush the final response, or finish immediately if connection cleanup won. */
export function endControlSocket(socket: Socket, response = ""): Promise<void> {
  return new Promise(resolve => {
    const flushed = () => { socket.off("close", flushed); resolve() }
    // Socket.end's callback is never called when the socket was already destroyed.
    if (socket.destroyed) return resolve()
    socket.once("close", flushed)
    socket.end(response, flushed)
  })
}
