import assert from "node:assert/strict"
import test from "node:test"
import {
  REQUIRED_PUBLISH_TEST_JOBS,
  hasFullPassingTestSuite,
  shouldSkipPublishTest,
  shouldSkipScheduledRun,
} from "./ci-check-existing-run.ts"

const sha = "a".repeat(40)
const otherSha = "b".repeat(40)

function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  return async (url: string) => {
    const path = url.replace(/^https:\/\/api\.github\.com/u, "")
    const entry = routes[path]
    if (!entry) return { ok: false, status: 404, json: async () => ({}) }
    const status = entry.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => entry.body }
  }
}

test("shouldSkipScheduledRun skips only when Publish or a prior schedule succeeded on the exact HEAD SHA", async () => {
  const publishHit = await shouldSkipScheduledRun({
    repository: "yet-another-ai/deskfleet",
    sha,
    token: "tok",
    fetchImpl: stubFetch({
      [`/repos/yet-another-ai/deskfleet/actions/workflows/publish.yml/runs?head_sha=${sha}&status=completed&per_page=10`]: {
        body: { workflow_runs: [{ id: 1, head_sha: sha, status: "completed", conclusion: "success" }] },
      },
    }),
  })
  assert.equal(publishHit, true)

  const scheduleHit = await shouldSkipScheduledRun({
    repository: "yet-another-ai/deskfleet",
    sha,
    token: "tok",
    fetchImpl: stubFetch({
      [`/repos/yet-another-ai/deskfleet/actions/workflows/publish.yml/runs?head_sha=${sha}&status=completed&per_page=10`]: {
        body: { workflow_runs: [{ id: 1, head_sha: sha, status: "completed", conclusion: "failure" }] },
      },
      [`/repos/yet-another-ai/deskfleet/actions/workflows/ci.yml/runs?head_sha=${sha}&event=schedule&status=completed&per_page=10`]: {
        body: { workflow_runs: [{ id: 2, head_sha: sha, status: "completed", conclusion: "success" }] },
      },
    }),
  })
  assert.equal(scheduleHit, true)

  const miss = await shouldSkipScheduledRun({
    repository: "yet-another-ai/deskfleet",
    sha,
    token: "tok",
    fetchImpl: stubFetch({
      [`/repos/yet-another-ai/deskfleet/actions/workflows/publish.yml/runs?head_sha=${sha}&status=completed&per_page=10`]: {
        body: { workflow_runs: [{ id: 1, head_sha: otherSha, status: "completed", conclusion: "success" }] },
      },
      [`/repos/yet-another-ai/deskfleet/actions/workflows/ci.yml/runs?head_sha=${sha}&event=schedule&status=completed&per_page=10`]: {
        body: { workflow_runs: [] },
      },
    }),
  })
  assert.equal(miss, false)
})

test("shouldSkipPublishTest requires every full-matrix test job to succeed on the exact SHA", async () => {
  const fullJobs = REQUIRED_PUBLISH_TEST_JOBS.map(name => ({ name, conclusion: "success" }))
  assert.equal(hasFullPassingTestSuite(fullJobs), true)
  assert.equal(
    hasFullPassingTestSuite(fullJobs.map(job => job.name === "Test / Tests (iOS)" ? { ...job, conclusion: "skipped" } : job)),
    false,
  )

  const reused = await shouldSkipPublishTest({
    repository: "yet-another-ai/deskfleet",
    sha,
    token: "tok",
    fetchImpl: stubFetch({
      [`/repos/yet-another-ai/deskfleet/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&status=completed&per_page=10`]: {
        body: { workflow_runs: [{ id: 42, head_sha: sha, status: "completed", conclusion: "success" }] },
      },
      "/repos/yet-another-ai/deskfleet/actions/runs/42/jobs?per_page=100&page=1": {
        body: { jobs: fullJobs },
      },
    }),
  })
  assert.equal(reused, true)

  const partial = await shouldSkipPublishTest({
    repository: "yet-another-ai/deskfleet",
    sha,
    token: "tok",
    fetchImpl: stubFetch({
      [`/repos/yet-another-ai/deskfleet/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&status=completed&per_page=10`]: {
        body: { workflow_runs: [{ id: 42, head_sha: sha, status: "completed", conclusion: "success" }] },
      },
      "/repos/yet-another-ai/deskfleet/actions/runs/42/jobs?per_page=100&page=1": {
        body: { jobs: fullJobs.slice(0, -1) },
      },
    }),
  })
  assert.equal(partial, false)
})

test("API errors and invalid SHAs fail safe to running CI", async () => {
  assert.equal(await shouldSkipScheduledRun({ repository: "yet-another-ai/deskfleet", sha: "bad", token: "tok" }), false)
  assert.equal(await shouldSkipPublishTest({ repository: "yet-another-ai/deskfleet", sha: "bad", token: "tok" }), false)
  const failingFetch = async () => { throw new Error("network down") }
  assert.equal(await shouldSkipScheduledRun({ repository: "yet-another-ai/deskfleet", sha, token: "tok", fetchImpl: failingFetch }), false)
  assert.equal(await shouldSkipPublishTest({ repository: "yet-another-ai/deskfleet", sha, token: "tok", fetchImpl: failingFetch }), false)
})
