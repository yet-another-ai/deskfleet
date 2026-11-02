import type { CentralApi, LocalMachineStatus } from "@deskfleet/client/central"
import type { LocalApplicationsApi, OpenWorkspaceRequest } from "@deskfleet/client/applications"
import type { CatalogSnapshot } from "@deskfleet/client/catalog"

export interface ApplicationLauncher {
  scan: LocalApplicationsApi["scan"]
  open(applicationId: string, directory: string): Promise<void>
}

/** Resolve live daemon paths through authorized management, never renderer-supplied paths. */
export class LocalApplicationsController implements LocalApplicationsApi {
  readonly #central: Pick<CentralApi, "status" | "rpc">
  readonly #enrollment: () => Promise<LocalMachineStatus>
  readonly #launcher: ApplicationLauncher

  constructor(
    central: Pick<CentralApi, "status" | "rpc">,
    enrollment: () => Promise<LocalMachineStatus>,
    launcher: ApplicationLauncher,
  ) {
    this.#central = central
    this.#enrollment = enrollment
    this.#launcher = launcher
  }

  scan(): ReturnType<LocalApplicationsApi["scan"]> { return this.#launcher.scan() }

  async openWorkspace(request: OpenWorkspaceRequest): Promise<void> {
    if ((request.workspaceId === undefined) === (request.worktreeId === undefined)) {
      throw new Error("Invalid application or Workspace identifier")
    }
    const [account, status] = await Promise.all([this.#central.status(), this.#enrollment()])
    const local = status.registrations.find(value => value.serverUrl === account.serverUrl && value.teamId === request.teamId && value.machineId === request.machineId)
    if (!account.user || !local?.configured || local.revoked || local.serverUrl !== account.serverUrl || local.machineId !== request.machineId) {
      throw new Error("Only Workspaces on this client's local machine can be opened")
    }
    const catalog = await this.#central.rpc<CatalogSnapshot>(request.teamId, request.machineId, "catalogList", {})
    if (catalog.machineId !== local.identity.machineId) throw new Error("Workspace machine does not match the local machine")
    const worktrees = request.worktreeId !== undefined
      ? [...catalog.sessions, ...catalog.workspaces.flatMap(workspace => workspace.worktrees)]
      : undefined
    const directories = request.worktreeId !== undefined
      ? worktrees?.find(worktree => worktree.id === request.worktreeId)?.directories
      : catalog.workspaces.find(workspace => workspace.id === request.workspaceId)?.worktrees.find(worktree => worktree.sessionId === undefined)?.directories
    const directory = directories?.[request.directoryIndex ?? 0]
    if (!directory) throw new Error("Workspace directory is unavailable")
    await this.#launcher.open(request.applicationId, directory.path)
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0")) throw new Error("Invalid application or Workspace identifier")
  return value
}

export async function invokeApplications(api: LocalApplicationsApi, method: unknown, value: unknown): Promise<unknown> {
  if (method === "scan") return api.scan()
  if (method !== "openWorkspace") throw new Error("Unknown local application operation")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Workspace request")
  const input = value as Record<string, unknown>
  if ((input.workspaceId === undefined) === (input.worktreeId === undefined)) {
    throw new Error("Invalid application or Workspace identifier")
  }
  if (input.directoryIndex !== undefined && (!Number.isSafeInteger(input.directoryIndex) || (input.directoryIndex as number) < 0)) {
    throw new Error("Invalid Workspace directory index")
  }
  return api.openWorkspace({
    applicationId: identifier(input.applicationId), teamId: identifier(input.teamId), machineId: identifier(input.machineId),
    ...(input.workspaceId === undefined ? {} : { workspaceId: identifier(input.workspaceId) }),
    ...(input.worktreeId === undefined ? {} : { worktreeId: identifier(input.worktreeId) }),
    ...(input.directoryIndex === undefined ? {} : { directoryIndex: input.directoryIndex as number }),
  })
}
