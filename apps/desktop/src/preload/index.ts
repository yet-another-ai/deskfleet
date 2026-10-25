import { contextBridge, ipcRenderer } from "electron"
import type { CentralApi, CentralEvent } from "@deskfleet/client/central"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { desktopApi } from "./api.ts"

const central = Object.fromEntries([
  "status", "setServer", "login", "logout", "teams", "createTeam", "enrollHeadless", "members", "renameTeam", "invite", "acceptInvite", "setMemberRole", "removeMember", "machines", "renameMachine", "removeMachine", "localEnrollment", "enrollLocal", "catalog", "sessions", "session", "events", "rpc", "createPeer", "offerPeer", "startPeer", "candidatePeer", "closePeer",
].map(method => [method, (...args: unknown[]) => ipcRenderer.invoke("deskfleet:central", method, args)])) as unknown as CentralApi
central.onEvent = listener => {
  const handler = (_event: Electron.IpcRendererEvent, value: CentralEvent) => listener(value)
  ipcRenderer.on("deskfleet:central-event", handler)
  return () => ipcRenderer.removeListener("deskfleet:central-event", handler)
}

if (isMainRendererUrl(globalThis.location.href)) {
  contextBridge.exposeInMainWorld("deskfleet", desktopApi(central))
}
