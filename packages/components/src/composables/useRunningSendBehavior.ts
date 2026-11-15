import { useStorage } from "@vueuse/core"

export const RUNNING_SEND_BEHAVIOR_STORAGE_KEY = "deskfleet.running-send-behavior"

/** A viewing-device preference shared by the account and nested machine surfaces. */
export function useRunningSendBehavior() {
  return useStorage(RUNNING_SEND_BEHAVIOR_STORAGE_KEY, "backlog", undefined, { writeDefaults: false, flush: "sync" })
}
