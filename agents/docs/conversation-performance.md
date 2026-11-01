# Conversation rendering performance

Use the conversation benchmark to compare renderer changes against the same
multi-turn workload. It builds the shared Vue components in production mode and
runs them in the repository's locked Electron runtime. The harness mounts the
real `AgentConversation` and `AgentOutline`, including their event projections,
Markdown parser, syntax highlighter, math renderer, Mermaid renderer, and
disclosures.

## Run a comparison

Run from the repository root in a login shell, using PowerShell 7 on Windows:

```sh
mise exec -- node scripts/benchmark-conversation.ts --turns '0,20,80' --rounds 3 --label candidate-collapsed
mise exec -- node scripts/benchmark-conversation.ts --turns '20,80' --rounds 3 --expanded --scroll history --label candidate-expanded-history
```

The first command follows the bottom of a conversation with collapsed historical
work. The second leaves the viewport at historical content and expands nested
work, activity, thought, and tool disclosures before streaming. Both cases open
a historical work disclosure and its activity group halfway through streaming;
the expanded case closes and reopens that disclosure to measure a real action.
The zero-history case has no historical disclosure to open.

Use `--profile` to save Chromium CPU profiles alongside a run. Load a `.cpuprofile`
in Chromium DevTools to inspect JavaScript work. Profiled runs should be compared
with other profiled runs because profiling adds overhead.

The default offered load is 120 text chunks at 16 ms intervals, plus one tool
event. Change `--chunks` and `--interval-ms` together with the scenario label when
testing a different load. Run at least three rounds on the same machine with the
same power settings and other applications idle. The runner prints medians of
per-round measurements; retain individual samples to see variance.

`--skip-build` reuses the last renderer build. It is useful for repeating a
scenario against identical output, but it does not incorporate source edits.
Each normal run rebuilds before measuring. Run benchmarks sequentially: the
build directory and generated Electron runner are shared.

## Workload and runtime

[`fixture.ts`](../../packages/components/benchmarks/conversation/fixture.ts)
generates deterministic journal events and a matching snapshot. Every historical
turn contains a delivered user input, streamed thought, completed tool call with
output, mixed-format assistant answer, and completed turn. The live turn starts
with a thought, streams additional thought chunks, emits a tool call, streams an
answer, and completes.

The text includes English and Chinese prose, headings, emphasis, inline code,
nested lists, blockquotes, tables, links, TypeScript fences, and inline/block math.
Every fourth mixed section also contains long single-line JSON and a small
Mermaid flowchart. Historical text is represented by multiple journal chunks,
so increasing the turn count increases both event replay and mounted content.
No external image or file resource is fetched.

The harness uses the production event-count watcher pattern from `SessionView`
to scroll after Vue's update flush. `--scroll history` leaves scrolling fixed.
It includes the outline's projection cost, but does not simulate hovering its
tooltips or the complete session view and application chrome.

Each round gets a fresh hidden Electron window with a 1280 × 900 viewport,
offscreen rendering requested at 60 frames per second, and background throttling
disabled. The page uses a light CSS color scheme and English locale; Mermaid
uses the appearance store's system theme. Keep the OS theme unchanged across
comparisons. These settings make
the workload repeatable without opening an interactive window. The measured
animation-frame intervals are **offscreen renderer scheduling measurements**;
they are not the visible application's FPS or a compositor presentation trace.

The benchmark starts at the component `events`/`snapshot` boundary. It excludes
provider generation, daemon journaling, WebRTC, session-store ingestion, and
network delivery. An improvement here does not establish that those upstream
queues are keeping up.

## Measurements

The harness schedules arrivals against an absolute clock. If rendering delays a
timer, it delivers all events already due and records their lateness instead of
silently lowering the offered load. Vue may combine those arrivals into one
update; `deliveryBatches` and `largestDeliveryBatch` make this visible.

| Field | Meaning |
| --- | --- |
| `mountMs` | Application mount through Vue's first update and animation frame. |
| `unfoldMs` | Initial disclosure-opening work through an animation frame; the collapsed case also includes its readiness frame. |
| `preStreamSettleMs` | Time after initial mounting/unfolding until historical text is stable for three frames and mounted Mermaid diagrams have SVGs. This setup interval is reported separately from streaming. |
| `streamMs` / `offeredStreamMs` | Actual time to deliver the final scheduled event versus the fixed offered duration. |
| `deliveryLatenessMs` | Per-event delay from its intended arrival time; reports count, p50, p95, and maximum. |
| `eventToFrameMs` | Time from delivering an event batch through `nextTick` and the next animation-frame callback. Each event in the batch receives that batch's latency. This approximates update readiness, not pixel presentation. |
| `frameIntervalMs` | Animation-frame intervals during streaming and final settling; reports count, p50, p95, and maximum. |
| `longTasks` | Chromium long-task count, total duration, and maximum duration during the measured streaming/settling window; includes support status. |
| `expandDuringStreamMs` | Opening historical work and its activity group through the next frame. It does not wait for asynchronous Mermaid rendering. Null when there is no historical turn. |
| `diagramReopenReadyMs` / `diagramReopenStatus` | From the same expand click until the reopened response's mounted diagrams contain SVGs. Status distinguishes ready, timeout, and not-applicable; the 15-second wait does not extend existing timing windows. |
| `finalCatchupMs` | Time from final text delivery through completion and final-answer readiness, including three stable frames. |
| `initialDom` / `finalDom` | Element, Markdown, code-block, disclosure, hidden-descendant, and diagram counts at the scenario boundaries. Hidden descendants only count nodes under the HTML `hidden` attribute. |
| `diagramValidation` | Post-measurement counts of duplicate SVG IDs, unresolved local references, and missing expected fixture labels. Diagnostic failures remain visible in JSON without preventing comparison with an older renderer. |

Final readiness inspects only the last response, avoiding an extra
history-sized layout/text scan on every settling frame. It requires visible
final prose, the complete code sentinel inside Shiki token containers, all
mounted final-response Mermaid diagrams to contain rendered SVGs, and unchanged
text for three frames. A plain code fallback does not satisfy the highlighted
sentinel check. The wait fails after 15 seconds. It does not wait for unrelated
historical diagrams opened during streaming.

Initial settling fails after 30 seconds. Each renderer round has a 180-second
outer timeout. These are failure bounds, not performance targets. The runner
does not assert timing thresholds across different hardware.

## Evidence and baseline selection

Results live under the gitignored `result/conversation/<label>/` directory:

- `results.json` contains individual rounds, scenario options, Electron and
  Chromium versions, measurements, and completion status.
- `metadata.json` records machine/OS/CPU information, Node version, viewport,
  offscreen frame rate, options, and renderer build provenance.
- Optional `<turns>-<round>.cpuprofile` files contain Chromium CPU samples.

Build provenance records the Git commit, dirty status, tracked diff hash, and
SHA-256 hashes of `pnpm-lock.yaml`, `AgentMarkdown.vue`, the Mermaid service and
SVG helper, `fixture.ts`, and `Harness.vue` (older runs predate the Mermaid source
hashes). Run metadata also records the built index hash. With
`--skip-build`, provenance describes the reused build rather than the current
source tree. The tracked diff hash does not include untracked files; retain the
benchmark source revision as well as JSON output when sharing a result.

The initial comparison starts from commit
`7f808607d496f7fc35ce6a2cbd3ecba7b9a13478`, which already includes the change
disabling Markdown batch rendering. The baseline uses that commit's
`AgentMarkdown.vue` with the new benchmark harness. The candidate uses the same
fixture, runner, dependencies, and other production code, changing only the
Markdown integration under investigation.

To repeat that isolated comparison, save the original component and candidate
component as byte-preserving copies in an ignored temporary directory such as
`result/conversation/source/`. Confirm the original matches the component at
the baseline commit. Restore only that component for the baseline build, then
restore the saved candidate for the candidate build. Use distinct labels and
rebuild both revisions; keep the candidate restoration in a `finally` block if
automating the swap. Do not replace the active branch or discard unrelated
working-tree edits. Check the recorded component, fixture, and lockfile hashes
before comparing results.

## Initial measured comparison

Measured on 2026-11-01 with an AMD Ryzen 9 7900X, Windows 11 build 22631,
Node 24.22.1, Electron 45.1.0 / Chromium 156.0.8078.49, system dark appearance,
and the fixed 60 Hz offscreen configuration. Each row is the median of three
rounds with 120 text chunks at 16 ms intervals (17,948 source characters plus
one tool event). The baseline already has batch rendering disabled. The
candidate registers custom Markdown components once per module instead of
invalidating all existing renderer caches whenever another message mounts.

All values below are milliseconds; arrows mean baseline → candidate. Frame and
update columns are medians of each round's p95, not pooled percentiles.

| History / scenario | Mount | Frame interval p95 | Update-to-frame p95 | Final catchup | Long-task total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 / collapsed, bottom | 33.6 → 34.4 | 16.8 → 16.8 | 25.0 → 28.4 | 132.2 → 120.0 | 183 → 172 |
| 20 / collapsed, bottom | 614.4 → 474.6 | 50.1 → 50.0 | 73.3 → 77.8 | 310.6 → 260.2 | 589 → 442 |
| 80 / collapsed, bottom | 2562.3 → 1203.5 | 350.0 → 250.0 | 52.6 → 100.9 | 895.3 → 661.3 | 1962 → 1250 |
| 20 / expanded, history | 602.8 → 503.0 | 150.0 → 149.9 | 103.3 → 24.4 | 418.8 → 368.5 | 1313 → 991 |
| 80 / expanded, history | 2569.3 → 1248.9 | 849.9 → 533.3 | 972.5 → 130.1 | 3060.1 → 1740.0 | 4961 → 3178 |

At 80 turns, the fixture has 3,759 historical events. The collapsed scenario
mounts 55,674 elements; full expansion mounts 111,002. Opening all nested work
takes 43,505.4 → 1,612.7 ms. Subsequent historical settling still takes
22,885.2 → 22,599.0 ms while waiting for text stability and 40 Mermaid SVGs.
This remaining rich-content setup cost is separate from the streaming window.

The change improves mounting, disclosure expansion and completion in these
samples, but does not solve long-history rendering. The collapsed scenario's
update-to-frame p95 increased, and large frame gaps remain. Use all metrics,
including delivery lateness and batching in the raw samples, rather than
treating one summary number as overall responsiveness.

The separate ordered-event append optimization is covered by store regression
tests; these renderer measurements bypass that store and do not quantify its
benefit. The tests cover reactive transcript updates, duplicates, gaps, late
history, and preservation of history/snapshot sequence advancement.

Raw local evidence is in `result/conversation/baseline-v2-collapsed/`,
`baseline-v2-expanded-history/`, `candidate-collapsed/`, and
`candidate-expanded-history/`. Lockfile, fixture and harness hashes match across
the comparison. Generated evidence stays untracked; preserve those JSON files
when sharing measurements. Earlier smoke and pre-calibration runs are excluded.

## Shared-projection checkpoint

The next checkpoint supplies a single computed projection from `SessionView` to
both consumers. The benchmark mirrors that composition change; its fixture,
pacing and measurement logic are unchanged. The integration test verifies one
replay per update and synchronized conversation/outline output. No incremental
reducer or final-message relocation is included.

Comparing the initial candidate at `e6f7c95` with shared projection on the same
machine and three rounds per scenario, all values are milliseconds:

| History / scenario | Mount | Frame interval p95 | Update-to-frame p95 | Final catchup | Long-task total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 / collapsed, bottom | 34.4 → 34.8 | 16.8 → 16.8 | 28.4 → 24.6 | 120.0 → 137.5 | 172 → 184 |
| 20 / collapsed, bottom | 474.6 → 471.7 | 50.0 → 33.3 | 77.8 → 23.8 | 260.2 → 271.8 | 442 → 463 |
| 80 / collapsed, bottom | 1203.5 → 1196.0 | 250.0 → 200.1 | 100.9 → 31.4 | 661.3 → 632.6 | 1250 → 1172 |
| 20 / expanded, history | 503.0 → 453.0 | 149.9 → 133.3 | 24.4 → 26.1 | 368.5 → 339.0 | 991 → 942 |
| 80 / expanded, history | 1248.9 → 1206.4 | 533.3 → 533.4 | 130.1 → 109.9 | 1740.0 → 1741.9 | 3178 → 3071 |

Sharing removes the duplicate replay, but does not substantially change the
expanded 80-turn completion or frame tail. Some small-case timings increased.
This is a limited optimization, not evidence that history-sized work or rich
content stalls are resolved. Local samples are in
`result/conversation/shared-projection-collapsed/` and
`result/conversation/shared-projection-expanded-history/`.

## Mermaid template cache

The renderer-local Mermaid service caches successful SVG templates by exact
source and light/dark theme. An LRU limits retained templates to 64 entries and
4 MiB of accounted UTF-16 source/SVG/document-URL text. Identical pending requests
share one render. Failed renders are removed so incomplete streaming syntax can
be retried. Mermaid initialization and rendering run in one queue because
initialization mutates global configuration outside Mermaid's internal queue.

Each consumer receives an SVG with fresh IDs. A detached-DOM/CSSOM pass updates
local URL references, href/xlink, accessibility references, CSS ID selectors and
exact ID/reference attribute selectors while preserving labels, colors and
external links. Templates retain their complete originating document URL,
including the hash route, so cached absolute marker references still work after
SPA navigation. The cache is neither
persistent nor shared across renderer windows.

The unchanged expanded/history workload already exercises repeat requests:
completion remounts the live answer diagram, mid-stream reopening mounts a
historical diagram again, and the expanded thought contains identical diagram
sources. Both sides of this comparison use the added SVG-ready disclosure
measurement and post-run reference/label diagnostics. The uncached service comes
from `e31717a`; all other scenario settings match the earlier checkpoints.

Three-round medians, in milliseconds:

| Historical turns | Diagram reopen ready | Completion catchup | Frame interval p95 | Long-task total | Initial rich-content settle |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 | 234.3 → 72.0 | 334.6 → 193.2 | 133.3 → 50.0 | 972 → 496 | 1640.1 → 1541.0 |
| 80 | 689.8 → 188.7 | 1688.2 → 634.9 | 516.7 → 516.7 | 3000 → 2163 | 22474.7 → 22384.7 |

Caching reduces repeated rendering but does not improve the large-case frame
tail or cold rich-content setup materially. All six candidate rounds report zero
duplicate SVG IDs, unresolved local references and missing fixture labels, with
diagram reopen status `ready`. Focused tests additionally cover simultaneous
copies, theme isolation, retry, LRU/byte limits, CSS/text preservation, and cached
absolute references after path and hash-route changes, including HTTP and file
URLs. Helper CSS tests isolate Happy DOM's
missing browser behavior in test-only shims; the real Electron runs exercise the
native HTML/SVG/CSSOM path.

Local evidence: `result/conversation/mermaid-uncached-expanded/` and
`result/conversation/mermaid-cached-expanded/`.

## Next optimization candidates

Evaluate each candidate with the collapsed and expanded/history scenarios, then
verify its functional boundaries with focused tests:

1. **Incrementally project the journal.** `SessionView` now supplies one shared
   `projectConversation` result to `AgentConversation` and `AgentOutline`; each
   component retains its standalone fallback for isolated callers. The shared
   projection still replays history and recreates response objects. An
   incremental projection can avoid replaying completed history. Reconnects,
   snapshot corrections, message IDs,
   and tool metadata must retain their existing ordering and merge semantics.
2. **Preserve the final message across completion.** `AgentResponse` moves the
   last assistant message from its work section into the final-answer section.
   Keeping that message mounted could avoid repeating Markdown and rich-block
   initialization at the exact point measured by final catchup. The component
   must also retain its identity when a later tool/thought follows an assistant
   progress message; placing only the last message in a separate subtree moves
   the remount cost to that transition and resets preview state.
3. **Coalesce superseded Mermaid work.** The Mermaid service now shares identical
   pending renders and caches completed templates by exact source and theme.
   It still renders distinct queued streaming revisions. Further work should
   measure stale-request elimination with theme changes, disposal and unique SVG
   identifiers covered.
4. **Keep parsing on the incremental path.** Inspect how custom parser settings
   and Markdown hooks affect the installed renderer's incremental parsing and
   stable-node reuse. Preserve local file-link validation while comparing the
   same output and malformed/incomplete streaming syntax. Removing the current
   `customMarkdownIt` hook is not equivalent to using `parseOptions.validateLink`
   alone: angle-delimited `file://server/share/report.md` and `file:relative.md`
   destinations can retain literal brackets through parser recovery. The latter
   option filters parsed links after tokenizer validation, so the hook remains.
5. **Limit offscreen rendering.** A viewport strategy can bound mounted history,
   but must preserve disclosure state, scroll position, locate actions, copy,
   and accessibility. Compare history reading and disclosure expansion as well
   as bottom-following streams; moving work to later scrolling is observable.

These are investigation priorities, not claims that every candidate is a
measured bottleneck or has already been implemented.
