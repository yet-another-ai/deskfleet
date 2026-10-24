import assert from "node:assert/strict"
import { Socket } from "node:net"
import test from "node:test"
import { endControlSocket } from "./control-socket.ts"

test("a response ending after connection cleanup does not leave shutdown pending", { timeout: 5_000 }, async () => {
  const socket = new Socket()
  socket.destroy()
  await endControlSocket(socket, JSON.stringify({ id: 1, error: "Authenticate with the local daemon first" }) + "\n")
  assert.equal(socket.listenerCount("close"), 0)
})
