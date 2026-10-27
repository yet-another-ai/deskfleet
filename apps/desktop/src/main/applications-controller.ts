import type { CentralApi, LocalEnrollment } from "@deskfleet/client/central"
import type { LocalApplicationsApi, OpenWorkspaceRequest } from "@deskfleet/client/applications"
import type { CatalogSnapshot } from "@deskfleet/client/catalog"

export interface ApplicationLauncher {
  scan: LocalApplicationsApi["scan"]
  open(applicationId: string, directory: string): Promise<void>
}

/** Resolve live daemon paths through authorized management, never renderer-supplied paths. */
export class LocalApplicationsController implements LocalApplicationsApi {
  readonly #central: Pick<CentralApi, "status" | "rpc">
  readonly #enrollment: () => Promise<LocalEnrollment>
  readonly #launcher: ApplicationLauncher

  constructor(
    central: Pick<CentralApi, "status" | "rpc">,
    enrollment: () => Promise<LocalEnrollment>,
    launcher: ApplicationLauncher,
  ) {
    this.#central = central
    this.#enrollment = enrollment
    this.#launcher = launcher
  }

  scan(): ReturnType<LocalApplicationsApi["scan"]> { return this.#launcher.scan() }

  async openWorkspace(request: OpenWorkspaceRequest): Promise<void> {
    const [account, local] = await Promise.all([this.#central.status(), this.#enrollment()])
    if (!account.user || !local.configured || local.revoked || local.serverUrl !== account.serverUrl || local.machineId !== request.machineId) {
      throw new Error("Only Workspaces on this client's local machine can be opened")
    }
    const catalog = await this.#central.rpc<CatalogSnapshot>(request.machineId, "catalogList", {})
    if (catalog.machineId !== local.identity.machineId) throw new Error("Workspace machine does not match the local machine")
    const workspace = catalog.workspaces.find(workspace => workspace.id === request.workspaceId)
    const directories = workspace?.worktrees.find(worktree => worktree.sessionId === undefined)?.directories
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
  if (input.directoryIndex !== undefined && (!Number.isSafeInteger(input.directoryIndex) || (input.directoryIndex as number) < 0)) {
    throw new Error("Invalid Workspace directory index")
  }
  return api.openWorkspace({
    applicationId: identifier(input.applicationId), machineId: identifier(input.machineId), workspaceId: identifier(input.workspaceId),
    ...(input.directoryIndex === undefined ? {} : { directoryIndex: input.directoryIndex as number }),
  })
}
