import { net, protocol, session, type Protocol, type Session, type WebContents } from "electron"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { isMainRendererUrl, RENDERER_HOST, RENDERER_SCHEME } from "../shared/renderer-security.ts"
import { rendererDirectory } from "./paths.ts"

interface RendererProtocolRequest {
  method: string
  url: string
}

type RendererResourceFetcher = (url: string) => Promise<Response>

function errorResponse(status: number): Response {
  return new Response(null, { status })
}

/** Must run before the app is ready. */
export function registerRendererScheme(
  target: Pick<Protocol, "registerSchemesAsPrivileged"> = protocol,
): void {
  target.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ])
}

/** Maps a renderer URL to a file inside `directory`, or null when it escapes it. */
export function resolveRendererResourcePath(
  requestUrl: string,
  directory = rendererDirectory,
): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${RENDERER_SCHEME}:` || parsed.host !== RENDERER_HOST) return null

  // URL parsing normalizes dot segments, so inspect the raw path instead.
  const rawPath = requestUrl.match(/^[^:]+:\/\/[^/?#]+([^?#]*)/)?.[1] ?? ""
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("\\") ||
    decodedPath.includes("\0") ||
    decodedPath.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return null
  }

  const resourcePath = decodedPath.slice(1)
  if (!resourcePath || isAbsolute(resourcePath)) return null

  const absolutePath = resolve(directory, resourcePath)
  const relativePath = relative(directory, absolutePath)
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  return absolutePath
}

export async function handleRendererProtocolRequest(
  request: RendererProtocolRequest,
  fetchResource: RendererResourceFetcher = (url) => net.fetch(url),
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405)
  const resourcePath = resolveRendererResourcePath(request.url)
  if (!resourcePath) return errorResponse(400)

  try {
    const response = await fetchResource(pathToFileURL(resourcePath).toString())
    return response.ok ? response : errorResponse(404)
  } catch {
    return errorResponse(404)
  }
}

export function installRendererProtocol(target: Pick<Protocol, "handle"> = protocol): void {
  target.handle(RENDERER_SCHEME, (request) => handleRendererProtocolRequest(request))
}

function allowsRendererPermission(
  webContents: WebContents | null,
  permission: string,
  details: { isMainFrame: boolean; requestingUrl?: string },
): boolean {
  return (permission === "clipboard-sanitized-write" || permission === "fullscreen")
    && details.isMainFrame
    && isMainRendererUrl(details.requestingUrl ?? "")
    && isMainRendererUrl(webContents?.getURL() ?? "")
}

/** Allow the main renderer's copy and fullscreen actions; deny other permissions. */
export function installRendererPermissions(
  target: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler"> = session.defaultSession,
): void {
  target.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    allowsRendererPermission(webContents, permission, details))
  target.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(allowsRendererPermission(webContents, permission, details)))
}
