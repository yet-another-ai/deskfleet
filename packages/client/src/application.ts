export const APPLICATION_RESTART_CHANNEL = "deskfleet:application-restart"

export interface ApplicationApi {
  restart(): Promise<void>
}
