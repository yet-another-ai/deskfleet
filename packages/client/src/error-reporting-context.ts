/** System versions shared with the renderer for error reports, without machine identity. */
export interface DesktopErrorReportingContext {
  os: { name: string; version: string }
  architecture: string
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
}
