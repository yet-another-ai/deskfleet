import { appendFileSync } from "node:fs"

export const REQUIRED_PUBLISH_TEST_JOBS = [
  "Test / Preflight",
  "Test / Static checks",
  "Test / Tests (Linux x64)",
  "Test / Tests (Windows x64)",
  "Test / Tests (macOS arm64)",
  "Test / Tests (Android)",
  "Test / Tests (iOS)",
  "Test / PostgreSQL and remote backend",
] as const

export interface WorkflowRunSummary {
  id: number
  head_sha: string
  status: string
  conclusion: string | null
  event?: string
}

export interface WorkflowJobSummary {
  name: string
  conclusion: string | null
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

async function githubJson<T>(
  apiUrl: string,
  path: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const response = await fetchImpl(`${apiUrl.replace(/\/+$/u, "")}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-github-api-version": "2022-11-28",
    },
  })
  if (!response.ok) {
    throw new Error(`GET ${path}: HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export function hasSuccessfulRunForSha(runs: readonly WorkflowRunSummary[], sha: string): boolean {
  return runs.some(run => run.head_sha === sha && run.status === "completed" && run.conclusion === "success")
}

export function hasFullPassingTestSuite(jobs: readonly WorkflowJobSummary[]): boolean {
  const succeeded = new Set(
    jobs.filter(job => job.conclusion === "success").map(job => job.name),
  )
  return REQUIRED_PUBLISH_TEST_JOBS.every(name => succeeded.has(name))
}

/** Skip a scheduled full CI run only when Publish or a prior scheduled CI run already succeeded for the exact HEAD SHA. */
export async function shouldSkipScheduledRun(options: {
  repository: string
  sha: string
  token: string
  apiUrl?: string
  fetchImpl?: FetchLike
}): Promise<boolean> {
  const { repository, sha, token, apiUrl = "https://api.github.com", fetchImpl = fetch } = options
  if (!repository || !/^[0-9a-f]{40}$/u.test(sha)) return false
  try {
    const publishRuns = await githubJson<{ workflow_runs: WorkflowRunSummary[] }>(
      apiUrl,
      `/repos/${repository}/actions/workflows/publish.yml/runs?head_sha=${sha}&status=completed&per_page=10`,
      token,
      fetchImpl,
    )
    if (hasSuccessfulRunForSha(publishRuns.workflow_runs ?? [], sha)) return true

    const scheduledRuns = await githubJson<{ workflow_runs: WorkflowRunSummary[] }>(
      apiUrl,
      `/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=schedule&status=completed&per_page=10`,
      token,
      fetchImpl,
    )
    return hasSuccessfulRunForSha(scheduledRuns.workflow_runs ?? [], sha)
  } catch {
    return false
  }
}

/** Skip Publish's Test workflow only when a completed main CI run for the exact tag SHA already passed every required test job. */
export async function shouldSkipPublishTest(options: {
  repository: string
  sha: string
  token: string
  apiUrl?: string
  fetchImpl?: FetchLike
}): Promise<boolean> {
  const { repository, sha, token, apiUrl = "https://api.github.com", fetchImpl = fetch } = options
  if (!repository || !/^[0-9a-f]{40}$/u.test(sha)) return false
  try {
    const ciRuns = await githubJson<{ workflow_runs: WorkflowRunSummary[] }>(
      apiUrl,
      `/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&status=completed&per_page=10`,
      token,
      fetchImpl,
    )
    const passingRuns = (ciRuns.workflow_runs ?? []).filter(
      run => run.head_sha === sha && run.status === "completed" && run.conclusion === "success",
    )
    for (const run of passingRuns) {
      const jobs: WorkflowJobSummary[] = []
      for (let page = 1; page <= 3; page++) {
        const pageData = await githubJson<{ jobs: WorkflowJobSummary[] }>(
          apiUrl,
          `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`,
          token,
          fetchImpl,
        )
        const batch = pageData.jobs ?? []
        jobs.push(...batch)
        if (batch.length < 100) break
      }
      if (hasFullPassingTestSuite(jobs)) return true
    }
    return false
  } catch {
    return false
  }
}

if (import.meta.main) {
  const mode = process.argv[2]
  const repository = process.env.GITHUB_REPOSITORY ?? ""
  const sha = process.env.GITHUB_SHA ?? ""
  const token = process.env.GITHUB_TOKEN ?? ""
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com"

  if (mode === "schedule") {
    const skip = await shouldSkipScheduledRun({ repository, sha, token, apiUrl })
    console.log(skip ? `Skipping scheduled CI: commit ${sha} was already validated by Publish or an earlier scheduled run.` : `Running scheduled CI for ${sha}.`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip_schedule=${skip}\n`)
  } else if (mode === "publish-test") {
    const skip = await shouldSkipPublishTest({ repository, sha, token, apiUrl })
    console.log(skip ? `Reusing passing main CI test results for ${sha}.` : `Running full Test suite for release commit ${sha}.`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip_test=${skip}\n`)
  } else {
    throw new Error("Usage: node scripts/ci-check-existing-run.ts <schedule|publish-test>")
  }
}
