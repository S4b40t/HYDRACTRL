# Signature Assist validation benchmark

The primary comparison launches the corrected application bundle in fresh Chromium contexts. The control unregisters Signature Assist through the existing plugin host. The treatment leaves it registered. The harness checks the plugin and auto-run states and holds the remaining app configuration constant.

## Reproduce

From the checkout root, install the locked dependencies and serve the normal build.

```sh
bun install --frozen-lockfile
bun run build
HOST=127.0.0.1 PORT=3127 bun src/index.ts
```

In a second shell with the same checkout and Bun on PATH, run the benchmark while the machine is otherwise idle.

```sh
HYDRACTRL_URL=http://127.0.0.1:3127/app \
BENCH_OUTPUT=/tmp/hydractrl-signature-benchmark.json \
node scripts/signature-assist-benchmark/run.mjs
node scripts/signature-assist-benchmark/summarize.mjs /tmp/hydractrl-signature-benchmark.json
```

The default is five pairs per setting. `PAIRS=1` runs a pilot. `CHROMIUM` overrides the default `/usr/bin/chromium` and `BUN` overrides the executable used by the diagnostic builder. Run against this checkout's locally served bundle. The raw output records its SHA-256, environment, fixture source, trial order, measured samples and run markers.

## Workload and endpoints

- Each page runs the same animated oscillator, noise modulation, rotation and color chain at a 1280×720 viewport and canvas. Small and medium workloads run with auto-run off and on. Stress uses the same rendering workload with auto-run off and substantially larger documents. Fixture padding uses dormant helpers. The native, documented and nested example calls are also dormant, so rewriting their numeric arguments changes source without changing the continuous workload.
- Each page warms up after the initial slot run. Arms run in alternating order within each setting. Trusted Playwright keyboard input replaces a selected digit in three valid call expressions. Browser-local bursts then replace one digit per expression in eight batches, cycling through the same valid expressions. Each batch sends a keydown to the app's actual auto-run listener. A separate post-burst phase includes the debounce and any successful run. The harness also navigates cached calls, switches editor tabs and loads seeded slots.
- **Dispatch** times entry to return of the wrapped CodeMirror `EditorView.dispatch`. It includes synchronous state updates and DOM work inside that call, and can include background dispatches during a labelled phase. It excludes GPU presentation, asynchronous shader execution and the entire keyboard event pipeline. Tab and slot figures are dispatch-only. Slot loads also trigger sketch runs, which are marked separately.
- **Input estimates** time capturing `beforeinput` to the next and second animation callbacks on the same page. Tooltip DOM time uses a mutation observer and excludes the subsequent placement and paint. Tooltip visibility is checked after the animation callbacks. These are browser scheduling proxies, with no compositor paint or display-present timestamp.
- **Frame intervals** are successive `requestAnimationFrame` timestamps within a phase. FPS is sample count divided by summed interval duration. Long frames exceed 25 ms. Estimated missed 60 Hz intervals sum `max(0, round(interval / 16.67 ms) - 1)`. This is a reference-cadence estimate, not GPU or display telemetry. Main-canvas WebGL draw calls and successful `sketch:run` events separately confirm functional rendering.
- **Cache** diagnostics use a temporary served bundle, with timings around active indexing and inactive parse plus index calls. The primary A/B arms use the normal bundle. The diagnostic pass records counts and duration per phase. It does not feed into the primary timing table.
- **Memory** uses Chrome DevTools `HeapProfiler.collectGarbage` and `Runtime.getHeapUsage` in a medium diagnostic page. Each cycle registers, edits, switches tabs and unregisters the plugin. The installed and disposed samples are whole-renderer V8 used heap after GC. They include editor history and other app activity and do not measure process RSS, native or GPU allocations.

The summarizer uses nearest-rank percentiles, IQR for variability, pooled per-arm samples, and per-pair p95 deltas. Timing results from this headless environment should be evaluated independently of Windows desktop or Spout acceptance.

## Recorded run

The [raw measurements](benchmarks/signature-assist-swiftshader.json) contain 25 alternating pairs (50 primary trials), three cache probes, and two ten-cycle heap series. The application was built from correction commit `7ef82919da3c9014213863f525b2fe4db74983c8` with Bun 1.4.5. The bundle SHA-256 was `a51f2ed3ba5b2c1531def708d698ab09dd9532488653570327a9394e341fac09`, verified against the file served by the app. Chromium 156.0.8078.79 ran headless with ANGLE Vulkan SwiftShader on Linux, driven by Node 24.22.1 and Playwright 1.63.0. The Intel Xeon Platinum 8573C environment exposed three CPUs with a two-CPU cgroup quota and 8 GiB memory limit. No synthetic browser CPU throttle was applied. The cgroup recorded throttling in 4,644 of 4,915 quota periods during the primary and diagnostic run, about 94.5%.

| Fixture | Setup chars / lines | Sketch chars / lines | Auto-run settings |
| --- | --- | --- | --- |
| Small | 666 / 16 | 700 / 13 | Off and on |
| Medium | 6,852 / 148 | 6,002 / 125 | Off and on |
| Stress | 50,412 / 1,048 | 44,102 / 905 | Off |

**The web performance gate remains open.** The enabled-minus-disabled edit-dispatch p95 was +2.6 to +11.9 ms for the small and medium settings, above the provisional ~2 ms target. The stress delta was +45.7 ms. Paired edit p95 deltas ranged from −24.1 to +42.4 ms across the representative settings, so the measured cost should not be transferred directly to a hardware browser.

### Synchronous editor dispatch

Off and on refer to Signature Assist. Durations and IQR are in milliseconds, and `n` counts dispatches.

| Fixture / auto-run | Phase | Off median / p95 · IQR · n | On median / p95 · IQR · n | Δ p95 |
| --- | --- | --- | --- | --- |
| small / off | cursor | 0.7 / 6.6 · 2.2 · 180 | 1.9 / 6.6 · 2.5 · 180 | +0.0 ms (+0.0%) |
| small / off | editing | 7.6 / 19.7 · 5.6 · 120 | 8.1 / 22.3 · 6.2 · 120 | +2.6 ms (+13.2%) |
| small / off | tab | 8.2 / 55.8 · 20.2 · 80 | 7.3 / 40.5 · 12.0 · 80 | -15.3 ms (-27.4%) |
| small / off | slot | 6.1 / 49.1 · 12.6 · 40 | 6.6 / 19.6 · 8.4 · 40 | -29.5 ms (-60.1%) |
| small / on | cursor | 0.8 / 5.2 · 1.0 · 180 | 2.4 / 10.6 · 3.4 · 180 | +5.4 ms (+103.8%) |
| small / on | editing | 6.2 / 19.8 · 6.0 · 120 | 8.0 / 26.8 · 5.8 · 120 | +7.0 ms (+35.4%) |
| small / on | tab | 6.2 / 45.8 · 16.0 · 80 | 9.7 / 47.5 · 16.8 · 80 | +1.7 ms (+3.7%) |
| small / on | slot | 5.4 / 31.6 · 11.2 · 40 | 8.1 / 43.8 · 10.4 · 40 | +12.2 ms (+38.6%) |
| medium / off | cursor | 0.8 / 6.3 · 1.1 · 180 | 1.7 / 8.2 · 2.0 · 180 | +1.9 ms (+30.2%) |
| medium / off | editing | 6.7 / 30.7 · 4.0 · 121 | 8.7 / 42.6 · 6.5 · 120 | +11.9 ms (+38.8%) |
| medium / off | tab | 7.7 / 82.8 · 44.3 · 80 | 21.3 / 85.0 · 37.2 · 80 | +2.2 ms (+2.7%) |
| medium / off | slot | 9.9 / 50.1 · 27.8 · 40 | 10.8 / 62.5 · 20.4 · 40 | +12.4 ms (+24.8%) |
| medium / on | cursor | 0.6 / 4.6 · 0.7 · 180 | 2.8 / 18.3 · 4.0 · 180 | +13.7 ms (+297.8%) |
| medium / on | editing | 5.3 / 24.0 · 4.7 · 121 | 9.5 / 33.2 · 6.3 · 121 | +9.2 ms (+38.3%) |
| medium / on | tab | 22.1 / 79.2 · 33.7 · 80 | 21.2 / 83.3 · 51.6 · 80 | +4.1 ms (+5.2%) |
| medium / on | slot | 6.2 / 36.2 · 22.1 · 40 | 10.0 / 31.7 · 19.7 · 40 | -4.5 ms (-12.4%) |
| stress / off | cursor | 0.7 / 6.3 · 1.1 · 180 | 2.1 / 9.1 · 2.3 · 180 | +2.8 ms (+44.4%) |
| stress / off | editing | 6.2 / 16.9 · 5.5 · 122 | 14.9 / 62.6 · 11.5 · 120 | +45.7 ms (+270.4%) |
| stress / off | tab | 36.3 / 109.0 · 68.3 · 80 | 36.9 / 107.1 · 74.9 · 80 | -1.9 ms (-1.7%) |
| stress / off | slot | 12.1 / 74.0 · 35.7 · 45 | 9.9 / 58.2 · 36.1 · 43 | -15.8 ms (-21.4%) |

### Frame intervals

Durations and IQR are in milliseconds, and `n` counts observed intervals. Both modes drew to the main WebGL canvas during idle and editing. All idle intervals exceeded 25 ms. Editing intervals exceeded 25 ms in 95.24–100% of samples per arm. The raw-derived summary also reports estimated missed 60 Hz intervals and the separate post-edit debounce window. Every auto-run-on trial emitted a successful run during editing or the post-edit phase. The off trials emitted none in those phases.

| Fixture / auto-run | Phase | Off p50/p95/p99 · IQR · n | On p50/p95/p99 · IQR · n | rAF/s off → on | Δ p95 | Pairs >5% worse |
| --- | --- | --- | --- | --- | --- | --- |
| small / off | idle | 183/350/350 · 117 · 13 | 183/333/333 · 100 · 14 | 4.84 → 4.88 | -17 ms (-5%) | 3/5 |
| small / off | editing | 233/383/383 · 117 · 14 | 217/317/450 · 117 · 21 | 4.22 → 4.38 | -67 ms (-17%) | 4/5 |
| small / on | idle | 200/283/283 · 117 · 15 | 200/400/400 · 167 · 14 | 5.26 → 4.49 | +117 ms (+41%) | 4/5 |
| small / on | editing | 217/533/533 · 183 · 14 | 217/600/683 · 134 · 22 | 4.00 → 4.07 | +67 ms (+13%) | 3/5 |
| medium / off | idle | 150/333/333 · 50 · 15 | 150/250/250 · 33 · 18 | 6.00 → 6.14 | -83 ms (-25%) | 2/5 |
| medium / off | editing | 200/267/267 · 34 · 18 | 200/450/500 · 150 · 21 | 5.02 → 4.77 | +183 ms (+69%) | 3/5 |
| medium / on | idle | 167/350/350 · 83 · 17 | 167/283/283 · 50 · 16 | 5.60 → 5.85 | -67 ms (-19%) | 2/5 |
| medium / on | editing | 200/467/467 · 133 · 19 | 200/500/733 · 133 · 23 | 4.45 → 4.30 | +33 ms (+7%) | 3/5 |
| stress / off | idle | 183/250/250 · 83 · 15 | 217/367/367 · 83 · 13 | 5.59 → 4.56 | +117 ms (+47%) | 4/5 |
| stress / off | editing | 233/350/350 · 150 · 19 | 250/433/433 · 150 · 19 | 4.47 → 3.65 | +84 ms (+24%) | 5/5 |

The disabled idle baseline was **4.84–6.00 rAF/s**. Small/auto-run-on idle p95 was over 5% worse in four of five pairs, and stress editing was over 5% worse in all five. Small/auto-run-off editing also crossed 5% in four of five pairs despite a lower pooled p95. These are review flags. With only 13–23 intervals per arm per idle/edit phase, sparse tails and saturation make the size and recurrence of a hardware frame-time effect uncertain. Neither arm reproduced 60 FPS.

### Trusted keystrokes and tooltip placement

The summarizer emits counts, medians, p95 and IQR for actual keyboard dispatch, the first and second animation callback from `beforeinput`, and tooltip DOM appearance, split by call category. For example, the documented call in the small/auto-run-off setting had a first-callback p95 of **198.7 ms off / 315.7 ms on**, and an enabled tooltip DOM median/p95 of **17.7 / 56.9 ms** (four DOM samples). In medium/auto-run-off, the corresponding first-callback p95 was **273.4 / 206.7 ms**, and tooltip DOM median/p95 was **21.6 / 56.5 ms** (five samples). The tooltip was positioned by the two-callback check in **55/60** enabled small/medium inputs and **11/15** stress inputs. The standalone smoke suite verified the interactive behavior with a wait for placement. These browser callback and mutation observations do not measure paint directly.

### Index cache and heap probes

A/I are active-index and inactive parse-plus-index calls from one diagnostic trial per fixture. Cache data are separate from the normal-bundle timing arms.

| Fixture | Cursor builds A/I | Edit builds A/I | Edit active p95 | Tab builds A/I | Slot builds A/I |
| --- | --- | --- | --- | --- | --- |
| small | 0/0 | 24/0 | 1.5 ms | 0/0 | 4/0 |
| medium | 0/0 | 24/0 | 6.4 ms | 0/0 | 4/0 |
| stress | 0/0 | 18/0 | 56 ms | 0/0 | 1/0 |

Cursor-only navigation and unchanged tab switches rebuilt neither index. Inactive cold parse plus index took 1.5, 23.4 and 105.3 ms in the small, medium and stress probes, respectively, with one observed sample per size. Fewer than 24 timed stress rebuilds can occur because the resolver waits for a complete syntax tree. Source edits do invalidate the active index, and slot loads sometimes require a new index.

| Medium post-GC V8 heap | Initial | After cycle 10 | Growth |
| --- | ---: | ---: | ---: |
| Register/edit/tab/dispose | 7,792 KiB | 8,931 KiB | +1,139 KiB |
| Matched edits/tabs with plugin absent | 7,770 KiB | 8,536 KiB | +766 KiB |

Both retained-heap series grew; the lifecycle arm grew about 373 KiB more. The tooltip was removed in all ten disposals. Within each lifecycle cycle, installed-minus-disposed used heap varied from about −13 to +30 KiB. The matched control was run separately against the same build. This single pair of sequences does not establish a leak or a steady-state bound. If replicated, take heap snapshots after warm-up and compare dominators, especially CodeMirror history, caches and detached nodes. Process RSS, GPU allocations and long-run retention were not measured.

### Review follow-up

Repeat the same A/B protocol on a hardware-accelerated browser that sustains the reference workload, with longer frame windows. The cache probe identifies whole-document indexing on edits as a likely contributor on larger sources. On small sources, the measured index cost was lower and this run cannot isolate tooltip DOM work from scheduling contention. If hardware traces confirm an indexing bottleneck, review a bounded change that reuses unaffected declaration records across edits before considering broader optimization.

The underscore correction passed 638 tests, up from 637 at v0.3, with clean lint/build and a passing real-editor smoke test. This benchmark does not validate Windows desktop, Resolume, or Spout.
