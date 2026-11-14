/** Marketing get-deskfleet section for choosing the right desktop installer. */
export const desktopAppDownloadUrl = "https://www.deskfleet.org/#get-deskfleet"

/** Official user manual page for running deskfleet-daemon on Android via Termux. */
export function androidDaemonGuideUrl(locale: string): string {
  if (locale.startsWith("zh")) return "https://www.deskfleet.org/zh/guide/android"
  if (locale.startsWith("ja")) return "https://www.deskfleet.org/ja/guide/android"
  return "https://www.deskfleet.org/guide/android"
}
