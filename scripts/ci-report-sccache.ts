import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

interface Statistics {
  stats: {
    cache_hits: { counts: Record<string, number> }
    cache_misses: { counts: Record<string, number> }
    cache_writes: number
    cache_read_errors: number
    cache_write_errors: number
  }
}

try {
  const result = spawnSync(process.env.SCCACHE_PATH ?? "sccache", ["--show-stats", "--stats-format=json"], { encoding: "utf8" })
  if (result.error || result.status !== 0) throw new Error("Statistics unavailable")
  const { stats } = JSON.parse(result.stdout) as Statistics
  const total = (values: Record<string, number>) => Object.values(values).reduce((sum, value) => sum + value, 0)
  const hits = total(stats.cache_hits.counts)
  const misses = total(stats.cache_misses.counts)
  const rows = [
    ["Hits", hits], ["Misses", misses],
    ["Hit rate", hits + misses ? `${(100 * hits / (hits + misses)).toFixed(1)}%` : "n/a"],
    ["Writes", stats.cache_writes], ["Read errors", stats.cache_read_errors], ["Write errors", stats.cache_write_errors]
  ]
  const gha = ["1", "true", "on"].includes(process.env.SCCACHE_GHA_ENABLED ?? "")
  const mode = !gha ? "local" : process.env.SCCACHE_GHA_RW_MODE === "READ_WRITE" ? "READ_WRITE" : "READ_ONLY"
  const report = [
    "### Compiler cache", "", `Mode: ${mode}`, "", "| Metric | Value |", "| --- | ---: |",
    ...rows.map(([label, value]) => `| ${label} | ${value} |`), ""
  ].join("\n")
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
  if (stats.cache_read_errors + stats.cache_write_errors > 0)
    console.warn("::warning::Compiler cache I/O errors occurred; see the job summary.")
} catch {
  console.warn("::warning::Compiler cache statistics could not be read.")
}
