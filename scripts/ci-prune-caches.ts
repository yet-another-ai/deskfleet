// Delete GitHub Actions caches that no run can use any more, keeping the
// repository below its quota so that eviction never removes a live entry.
//
// Only main writes caches. Pull requests and tags restore main's entries, and
// an entry saved on any other ref is visible only to that ref. Every cache key
// ends with segments that change with its inputs (lockfile hashes, toolchain
// versions); when they change, main saves a new entry and the old one stays
// until GitHub evicts it. Group main's entries by the key without those
// segments and keep only the newest of each group.

import { pathToFileURL } from "node:url"

export interface Cache {
  id: number
  key: string
  ref: string
  created_at: string
  size_in_bytes: number
}

const mainRef = "refs/heads/main"

/** The cache key without the segments that change with its inputs. */
export function cacheFamily(key: string): string {
  // A content hash or a locked version, such as an Electron release.
  let family = key.replace(/-(?:[0-9a-f]{8,}|\d+(?:\.\d+)+)$/u, "")
  // mise-action's periodic rebuild counter.
  family = family.replace(/-p\d+$/u, "")
  // rust-cache appends an environment hash before the lockfile hash.
  if (family.startsWith("v0-rust-")) family = family.replace(/-[0-9a-f]{8}$/u, "")
  return family
}

/** Caches to delete: all entries outside main, then all but main's newest per family. */
export function staleCaches(caches: readonly Cache[]): Cache[] {
  const stale = caches.filter(cache => cache.ref !== mainRef)
  const newest = new Map<string, Cache>()
  for (const cache of caches) {
    if (cache.ref !== mainRef) continue
    const family = cacheFamily(cache.key)
    const current = newest.get(family)
    if (!current) {
      newest.set(family, cache)
    } else if (Date.parse(cache.created_at) > Date.parse(current.created_at)) {
      stale.push(current)
      newest.set(family, cache)
    } else {
      stale.push(cache)
    }
  }
  return stale
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`,
      "x-github-api-version": "2022-11-28",
    },
  })
  // A concurrent run can delete the same entry first.
  if (!response.ok && response.status !== 404) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`)
  }
  return response
}

async function listCaches(repository: string): Promise<Cache[]> {
  const caches: Cache[] = []
  for (let page = 1; ; page++) {
    const response = await github(`/repos/${repository}/actions/caches?per_page=100&page=${page}`)
    const body = await response.json() as { actions_caches: Cache[] }
    caches.push(...body.actions_caches)
    if (body.actions_caches.length < 100) return caches
  }
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error("Set GITHUB_REPOSITORY to owner/name")
  const dryRun = process.argv.includes("--dry-run")
  const caches = await listCaches(repository)
  const stale = staleCaches(caches)
  const mebibytes = (items: readonly Cache[]) =>
    (items.reduce((total, cache) => total + cache.size_in_bytes, 0) / 2 ** 20).toFixed(0)
  for (const cache of stale) {
    console.log(`${dryRun ? "Would delete" : "Deleting"} ${cache.key} (${cache.ref}, ${cache.created_at})`)
    if (!dryRun) await github(`/repos/${repository}/actions/caches/${cache.id}`, { method: "DELETE" })
  }
  console.log(`Kept ${caches.length - stale.length} caches (${mebibytes(caches.filter(cache => !stale.includes(cache)))} MiB); ` +
    `${dryRun ? "would delete" : "deleted"} ${stale.length} (${mebibytes(stale)} MiB).`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
