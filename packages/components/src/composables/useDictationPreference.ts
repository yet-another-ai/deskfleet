import { useStorage } from "@vueuse/core"

export const DICTATION_STORAGE_KEY = "deskfleet.dictation-enabled"

/** A viewing-device preference shared by the account and nested machine surfaces. */
export function useDictationPreference() {
  return useStorage(DICTATION_STORAGE_KEY, true, undefined, { writeDefaults: false, flush: "sync" })
}
