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

Add `--trace` to save a Perfetto `.pftrace` with browser style, layout, paint and
user-timing events. Both profiling options archive the matching build's source
maps under the result directory, so rebuilding cannot silently invalidate stack
attribution. Conversation marks identify mount, stream start, final delivery and
final readiness; separate these phases before attributing a long task. A CPU
profile's native style/layout time can be charged to the JavaScript getter that
forced it, so JavaScript self time alone does not identify the operation's cost.

The default offered load is 120 text chunks at 16 ms intervals, plus one tool
event. Change `--chunks` and `--interval-ms` together with the scenario label when
testing a different load. Run at least three rounds on the same machine with the
same power settings and other applications idle. The runner prints medians of
per-round measurements; retain individual samples to see variance.

`--markdown-renderer vapor|vdom` selects the compilation mode for `AgentMarkdown`,
the custom components in `session/markdown/`, and `MermaidViewer`. The default is
`vapor`, matching production. The rest of the conversation stays in Vapor mode
in both variants. Markstream itself ships precompiled VDOM components, so this
experiment measures the effect of grouping the Markdown subtree in VDOM rather
than repeatedly crossing between rendering modes. It does not disable Vapor
throughout the application or change parser, caching, or scheduling settings.

`--skip-build` reuses the last renderer build for the selected Markdown mode.
Build provenance records that mode, and each mode has a separate build directory.
Run metadata separately hashes the current orchestration script, Electron runner
source and runner bundle, because `--skip-build` still rebuilds the runner.
It is useful for repeating a
scenario against identical output, but it does not incorporate source edits.
Each normal run rebuilds before measuring. Run benchmarks sequentially: the
generated Electron runner is shared. Alternate variant order across rounds when
comparing compilation modes.

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
| `scrollbackValidation` | Post-measurement checks for visible top/middle/bottom rows, scroll alignment, retained DOM/disclosures, and locating a collapsed thought. Readiness times are separate from streaming. |

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
SHA-256 hashes of `pnpm-lock.yaml`, the Markdown and conversation components,
parser service, Mermaid service and SVG helper, fixture and harness sources
(older runs predate some source hashes). Run metadata also records the built index hash. With
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

## Markdown compilation comparison

With Vue `3.6.0-rc.13`, plugin-vue `6.0.10`, and Markstream `2.0.21`, the
production `features.vapor: true` setting forces eligible SFCs into Vapor even
without a `vapor` attribute. Markstream's published renderer remains VDOM. The
current path therefore crosses from the Vapor Markdown wrapper to VDOM
Markstream and back to Vapor custom blocks. Vue's
[interop guidance](https://github.com/vuejs/core/releases/tag/v3.6.0-rc.1)
recommends separating regions by rendering mode; this provides a reason to
measure the alternative, not a performance guarantee.

The comparison changes nine Markdown-owned SFCs to VDOM, including code-token
leaves and `MermaidViewer`. Shared controls and the rest of the conversation
remain Vapor. Build provenance records actual compiler output for the selected
components and the surrounding harness/conversation/response. The runner guards
both Vue plugin hooks because include/exclude alone does not isolate `?vue`
subrequests in the installed plugin version.

Both variants use production sources from `9075727`, identical fixtures and
settings, and separate builds. Measurements ran on Windows 11, Ryzen 9 7900X,
Electron `45.1.0`, with 120 chunks at 16 ms intervals. Each of the four scenarios
ran three times per variant, reversing variant and scenario order in round two.
Every round opens a fresh renderer window. Commands for each variant are:

```sh
mise exec -- node scripts/benchmark-conversation.ts --markdown-renderer vapor --turns '20,80' --rounds 1 --label renderer-vapor-collapsed-1
mise exec -- node scripts/benchmark-conversation.ts --markdown-renderer vdom --turns '20,80' --rounds 1 --label renderer-vdom-collapsed-1
```

For expanded runs add `--expanded --scroll history`. Repeat with unique labels,
alternating variant order and using `--skip-build` after each variant's first
build. Three-round medians below are milliseconds, **Vapor → Markdown VDOM**:

| History / scenario | Mount | Frame interval p95 | Update-to-frame p95 | Final catchup | Long-task total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 / collapsed, bottom | 467.6 → 441.8 | 16.8 → 16.8 | 20.3 → 22.8 | 99.1 → 100.5 | 287 → 293 |
| 80 / collapsed, bottom | 1258.7 → 1165.2 | 166.6 → 199.9 | 27.7 → 30.4 | 352.3 → 412.9 | 867 → 919 |
| 20 / expanded, history | 474.0 → 442.0 | 50.0 → 50.0 | 22.5 → 25.2 | 189.1 → 197.5 | 473 → 493 |
| 80 / expanded, history | 1214.3 → 1088.0 | 516.6 → 533.3 | 100.4 → 94.2 | 659.7 → 711.6 | 2137 → 2206 |

VDOM reduces initial mount time by 5.5–10.4% in these samples, but does not
improve frame-interval tails or final catchup. The 80-turn expanded case has a
6.2% lower update-to-frame p95 and a 4.4% faster diagram reopen, while final
catchup is 7.9% higher. Its initial rich-content settling time changes only from
22,473.5 to 22,092.9 ms; both variants finish with 112,974 DOM elements. These
results do not support disabling Vapor as the fix for streaming completion lag.
Production compilation settings remain unchanged.

All 24 samples completed with matching fixture, initial/final DOM and diagram
counts across variants and rounds, successful diagram reopening, and no
duplicate SVG IDs, unresolved local references, or missing fixture labels.
Source hashes match between builds. The frame measurements remain offscreen
scheduling measurements, not visible application FPS. Local raw results are
`result/conversation/renderer-{vapor,vdom}-{collapsed,expanded}-{1,2,3}/`;
`renderer-ab-sequence.json` records execution order and
`renderer-ab-summary.json` retains medians and individual samples.

## Isolating Markdown and conversation costs

The full conversation benchmark cannot be compared directly with the upstream
playground: it mounts history, projects journal events, renders an outline,
opens disclosures, and remounts the final answer. Use the isolated harness to
separate those costs from one growing Markdown message:

```sh
mise exec -- node scripts/benchmark-conversation.ts --isolated-renderer upstream --corpus prose --repeats 16 --rounds 3 --profile --label isolated-upstream
mise exec -- node scripts/benchmark-conversation.ts --isolated-renderer upstream-hook --corpus prose --repeats 16 --rounds 3 --profile --skip-build --label isolated-hook
mise exec -- node scripts/benchmark-conversation.ts --isolated-renderer deskfleet --corpus prose --repeats 16 --rounds 3 --profile --skip-build --label isolated-deskfleet
```

`upstream` uses `MarkdownRender` directly. `upstream-hook` adds only a callback
returning the same MarkdownIt instance. `deskfleet` uses `AgentMarkdown`.
All variants disable pacing, batching and node virtualization for a complete-DOM
comparison; these are not upstream's recommended chat presets. Prose contains
headings, lists, quotes, tables and links. `--corpus rich` adds code, math and
Mermaid; upstream rich diagnostics use a scoped plain-code override to preserve
real Mermaid SVGs without the optional enhanced-code dependency. Those rich
surfaces differ from Deskfleet's Shiki highlighting and must not be presented as
equivalent rendering work. Feature counts and the preset are recorded in results.

### A parser extension disables incremental work

The installed Markstream `2.0.21` marks any `customMarkdownIt` callback as a custom
parser extension. In `stream-markdown-parser@1.2.25`, that flag excludes
`md.stream.parse`, selecting synchronous `md.parse(source, env)` instead. It also
disables stable top-level node reuse. Our callback only extends file-link
validation, but still triggers the conservative fallback. Its identity is stable
within an instance; this is not caused by recreating the callback on each update.

With 112,699 characters, 120 chunks at 16 ms intervals, three profiled rounds per
variant on the same machine, the medians were:

| Variant | Frame interval p95 | Update-to-frame p95 | Final catchup | Long-task total |
| --- | ---: | ---: | ---: | ---: |
| Direct Markstream | 16.8 ms | 29.2 ms | 326.4 ms | 386 ms |
| Same renderer + no-op hook | 83.4 ms | 128.0 ms | 366.8 ms | 1401 ms |
| AgentMarkdown | 133.3 ms | 149.8 ms | 332.9 ms | 1529 ms |

Direct and no-op variants have identical final DOM counts (19,397 elements and
192 tables). Their median whole-run sampled tokenizer time rises from 57 to
143 ms; fallback node-signature work rises from 16 to 270 ms, alongside more Vue
updates and garbage collection. Samples show the direct renderer's tail reparse
path and the hook variants' full parse path. These are whole-run totals, not
costs per equal numbers of updates: timer delays coalesce the offered 120 chunks
into median delivery-batch counts of 116, 44 and 39 respectively.
The long-message final catchup remains above 300 ms even in the direct variant;
restoring incremental parsing alone is not evidence that completion stalls are
eliminated.

At 7,069 characters, all three variants have a 16.7–16.8 ms frame p95 and no long
tasks. The single rich-message workload also completes at a 16.8 ms frame p95 in
both tested variants, with four formulas and one real diagram, though only
Deskfleet highlights its four code blocks. The extension penalty is therefore
particularly relevant to long answers, not proof that every small message is
slow. Preserve file-link behavior when fixing this: `parseOptions.validateLink`
alone does not replace tokenizer-level validation for all file destinations.

Local evidence: `result/conversation/isolation-summary.json`, the
`isolation-{prose,rich}-*` directories, and `isolation-profile-findings.md`.

### Browser style work dominates the long conversation

A phase-separated CPU/Perfetto capture of the 80-turn expanded/history workload
measured 2,231 ms of streaming, including 1,231 ms of exclusive style
recalculation. Three individual passes each touched more than 100,000 elements
and took 441, 442 and 287 ms. Geometry layout took 46 ms and painting 37 ms.
The shared journal projection and its descendants accounted for about 131 ms
of sampled streaming time. Historical projection remains a cost, but does not
explain those large browser style passes. This scenario does not auto-scroll.

Completion contains a 470 ms full-document style pass forced by the benchmark's
`innerText` readiness read. That read makes pending browser work synchronous;
it does not establish that the work would disappear before a real paint. The
streaming passes also occur in browser lifecycle tasks without a JavaScript
callback ancestor. Interpret `finalCatchupMs` as the existing readiness protocol,
not as pure Markdown parsing time.

A diagnostic that removes only displayed SVG styles preserves all 41 final
diagrams but retains the same full-document pass counts: 41 during initial
rendering, three while streaming and one on completion. Thus the displayed
stylesheet alone does not explain the invalidations. Scheduling samples instead
point toward Mermaid's temporary connected-DOM lifecycle; its renderer inserts
a temporary SVG stylesheet and measures labels before cleaning up the SVG.
The style-removal probe changes appearance and is not a production optimization.

Two further probes generate Mermaid inside its built-in sandbox iframe, decode
the resulting SVG, and retain the existing display/cache pipeline. They do not
change production security settings. The four single-run diagnostic cells were:

| Generation / displayed SVG styles | History settle | Frame p95 | Final catchup |
| --- | ---: | ---: | ---: |
| Current / retained | 24273.9 ms | 566.6 ms | 686.7 ms |
| Current / removed | 21821.4 ms | 483.3 ms | 711.3 ms |
| Isolated document / retained | 19517.0 ms | 416.6 ms | 489.3 ms |
| Isolated document / removed | 13849.8 ms | 316.7 ms | 425.1 ms |

All cells retain 41 final diagrams and pass SVG reference/label diagnostics.
DOM counts differ only by the 41 removed style elements. Neither intervention,
nor their combination, eliminates the stalls. These probes narrow contributing
mechanisms; they are not repeated performance baselines or ready-to-ship fixes.
In particular, a general isolation solution must retain diagram appearance and
the application's existing security policy. Passing a Shadow DOM container to
the installed Mermaid version alone is insufficient: several render helpers
still query the main `document.body`.

Local evidence: `diagnosis-current-expanded/analysis-notes.md`,
`diagnosis-style-{normal,stripped}/`, `diagnosis-generation-sandbox/`,
`diagnosis-sandbox-and-stripped/`, and `style-intervention-analysis.md` under
`result/conversation/`. Probe metadata records exact source overrides and map
hashes; production Mermaid code was not changed.

## Production fixes for parser and browser style costs

`AgentMarkdown` now owns one public Markstream parser per mounted message and
passes its structured nodes to `MarkdownRender`. It configures MarkdownIt's
existing URL validator directly before parsing, allowing filesystem destinations
without using the `customMarkdownIt` hook that disables incremental tokenization.
The parser receives `final` on every update, including completion without another
text change. Its existing file-link filtering also remains available to nested
Markdown renderers. Tests cover append, replacement, clearing, completion, late
reference definitions, nested HTML details, file destinations and unsafe schemes.

The parser also needs to know that our URL predicate is stateless. Without that,
it conservatively disables structured-node reuse in documents containing links,
and restoring incremental tokenization alone does not remove repeated Vue work.
A pinned `stream-markdown-parser@1.2.25` patch exports the parser's existing
`registerCacheStableLinkValidator` function with its deterministic-function
contract. Only our module-level URL predicate is registered. The patch changes
exports and type declarations, leaving parser algorithms and conservative
behavior for other callbacks intact. Tests verify node identity for completed
file/HTTP links and continued revalidation for an unregistered mutable validator.
Passing nodes also avoids `MarkdownRender`'s fallback signature calculation.
Vapor compilation remains enabled.

`AgentConversation` applies `content-visibility: auto` to historical transcript
rows. Chromium can skip style, layout and paint for distant rows while retaining
their DOM, components and disclosure state. Remembered intrinsic block sizes
preserve measured row heights; unseen input/response rows start with 5rem/24rem
estimates. Live responses, the latest entry (including its completed answer),
explicitly located entries, and printed content remain fully rendered. Keeping
the latest completed answer exempt is necessary: otherwise completion while
reading history can leave its rich content skipped.

Mermaid's strict security mode, SVG styles, cache and diagram rendering are
unchanged. The fixture still waits for every mounted historical diagram before
streaming. This bounds browser rendering work; it does not virtualize Vue
components or reduce retained DOM memory.

After the measured window, the full benchmark checks real scrollback at the top,
middle and bottom, then locates a thought through collapsed work/activity
ancestors. It checks visible text and hit testing, scroll alignment, retained DOM,
and disclosure state. `scrollbackValidation` reports readiness for these actions
separately from streaming. Add `--capture` to save the four corresponding
screenshots; captures also occur outside the measured window.
The harness retains native scroll anchoring, matching `SessionView`; disabling
it causes rows to drift as newly visible content replaces intrinsic size estimates.

### Before/after verification

The baseline is `73be9f94f5464e16215544311e86e7d95b09b5a2` in a detached
worktree; its production renderer matches the PR merge base `b6f1035`. Both sides
use native scroll anchoring and the same fixture, viewport, offered load and
dependency versions. The candidate adds the parser export patch above. The
baseline uses the common benchmark overlay with its production files and lockfile
unchanged. Three rounds per case ran sequentially on the same Windows/Ryzen 9
7900X machine in Electron 45.1.0. The isolated prose case is profiled; the full
conversation cases are not.

Medians in milliseconds, before → after:

| Scenario | Frame interval p95 | Update-to-frame p95 | Final catchup | Long-task total | Historical settle |
| --- | ---: | ---: | ---: | ---: | ---: |
| 112,699-character prose | 116.7 → 50.1 | 421.1 → 60.0 | 350.9 → 338.6 | 1567 → 740 | — |
| 20 turns, collapsed/bottom | 16.8 → 16.8 | 21.9 → 23.9 | 89.9 → 82.6 | 281 → 111 | 657.2 → 345.6 |
| 80 turns, collapsed/bottom | 233.3 → 33.4 | 34.3 → 31.6 | 356.2 → 102.2 | 919 → 145 | 5899.1 → 890.8 |
| 20 turns, expanded/history | 66.7 → 16.8 | 26.2 → 20.4 | 207.0 → 79.5 | 525 → 59 | 1721.5 → 611.1 |
| 80 turns, expanded/history | 533.3 → 66.7 | 99.5 → 48.0 | 662.8 → 132.7 | 2241 → 265 | 22870.5 → 2963.0 |

All 30 before/after samples completed. Matching scenarios have identical initial
and final DOM/feature counts; the 80-turn expanded case retains 112,974 elements
and 41 rendered diagrams. All diagram reference/label checks and reopen actions
pass. Candidate scrollback visits finish within 52 ms and collapsed-thought
locates within 120 ms in these runs, with retained DOM and disclosure state.
These are readiness measurements, not visible application FPS. Long-prose final
catchup remains about 339 ms, and the 20-turn collapsed update p95 does not improve.

The final scrollback verifier also checks neighboring rows intersecting the
viewport. Assertions run in a task after animation frames so the browser can
resume their rendering; optional screenshots wait for offscreen paint and then
capture the current page. This avoids reporting a stale compositor frame as a
blank history row. These stronger checks/capture synchronization are after the
measured window; they do not change the streaming baseline.

Local evidence: `result/conversation/fix-stable-{prose,bottom,history}/` and
`fix-summary.json`; baseline outputs are under
`result/pr-252-before/result/conversation/fix-before-{prose,native-bottom,native-history}/`.
Metadata records exact build/source hashes. The native-anchor overlay manifest
records the baseline's benchmark-only changes. The parser/component tests pass
22/22, the full renderer suite passes 1,391 tests, and root/desktop typechecks pass.

## Remaining optimization candidates

Evaluate each candidate with the collapsed and expanded/history scenarios, then
verify its functional boundaries with focused tests:

1. **Preserve the final message across completion.** `AgentResponse` moves the
   last assistant message from its work section into the final-answer section.
   Keeping that message mounted could avoid repeating Markdown and rich-block
   initialization at the exact point measured by final catchup. The component
   must also retain its identity when a later tool/thought follows an assistant
   progress message; placing only the last message in a separate subtree moves
   the remount cost to that transition and resets preview state.
2. **Incrementally project the journal.** `SessionView` now supplies one shared
   `projectConversation` result to `AgentConversation` and `AgentOutline`; each
   component retains its standalone fallback for isolated callers. The shared
   projection still replays history and recreates response objects. An
   incremental projection can avoid replaying completed history. Reconnects,
   snapshot corrections, message IDs,
   and tool metadata must retain their existing ordering and merge semantics.
3. **Coalesce superseded Mermaid work.** The Mermaid service now shares identical
   pending renders and caches completed templates by exact source and theme.
   It still renders distinct queued streaming revisions. Further work should
   measure stale-request elimination with theme changes, disposal and unique SVG
   identifiers covered.

These are investigation priorities, not claims that every candidate is a
measured bottleneck or has already been implemented.
