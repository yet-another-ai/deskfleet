export const LEGACY_ANTIGRAVITY_BINARY = /(?:^|[/\\])agy_acp_server(?:\.(?:par|exe))?$/iu

/** Retire legacy `agy_acp_server` binary paths back to the template default. */
export function normalizeAntigravityBinaryPath(rawBinaryPath: string): string | undefined {
  return LEGACY_ANTIGRAVITY_BINARY.test(rawBinaryPath) ? undefined : rawBinaryPath
}
