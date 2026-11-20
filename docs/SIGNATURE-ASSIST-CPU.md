# Isolated Signature Assist CPU benchmark

This diagnostic measures the existing Signature Assist state-update path with the locked CodeMirror and Lezer packages. Both arms use `EditorState`, JavaScript parsing, history, and the same input sequence. The treatment adds the real `signatureExtension` and reads its tooltip facet. The harness never creates an `EditorView`, invokes the tooltip's DOM factory, or evaluates any fixture code.

## Reproduce

From the repository root, with Bun on PATH and other browser or benchmark workloads stopped:

```sh
bun install --frozen-lockfile
BENCH_OUTPUT=/tmp/signature-cpu.json bun scripts/signature-assist-cpu/run.mjs
BENCH_OUTPUT=/tmp/signature-cpu-probes.json bun scripts/signature-assist-cpu/run.mjs --probe
node scripts/signature-assist-cpu/summarize.mjs /tmp/signature-cpu.json /tmp/signature-cpu-probes.json
```

Pass `PAIRS=1 REPEATS=2` before either Bun command for a pilot. The default records six alternating pairs of 24 transactions per arm and operation after eight warm-up transactions per batch. The probe process is treatment-only. The summarizer also accepts gzipped raw files and emits median, p95, p99, IQR, sample counts, and six per-pair p95 deltas. Percentiles use nearest rank.

## Fixtures and endpoints

The original [web benchmark artifact](benchmarks/signature-assist-swiftshader.json) supplies the exact base fixture text. Setup/Sketch sizes are **666/700 chars** (16/13 lines), **6,852/6,002 chars** (148/125 lines), and **50,412/44,102 chars** (1,048/905 lines). The small and medium fixtures represent everyday editing and the last fixture is a synthetic stress case. Base fixtures have 6/8, 72/64, and 522/454 Setup/Sketch top-level bindings respectively. Some scenarios add a short test declaration and call.

The same scenarios run in both arms. They cover switching between existing call sites with only a caret move, edits to native/custom/nested literal arguments, helper body edits, creation/rename/deletion, parameter defaults, JSDoc text, top-level and local shadowing, warm tab swaps, and changed slot text. Source changes use minimal replacements except tab and slot loads, which replace the whole document like the app. Assertions check the actual signature name, active source parameter, documentation, or absence of a hint on every operation.

- **Natural transaction:** Clock starts before `state.update(spec)` and stops after accessing the resulting state's tooltip facet and checking that the published tree covers the entire document. This includes synchronous state updates and incremental parsing. CodeMirror starts with its normal initial parse window and gets no view worker. A partial parse is reported as deferred. Its update time remains in the raw data, with ready-only statistics reported separately.
- **Completion-assisted transaction:** The same timing endpoint applies, with the initial tree completed before the batch. If an update returns an incomplete tree, a separate timer measures `forceParsing` through synchronous redispatch and reading the resulting facet. The total is update plus any forced recovery. Both arms undergo the same policy. This is a CPU accounting path and does not model time spent waiting for a browser background worker.
- **Component probes:** A Bun loader rewrites the two existing index call sites in memory with measurement wrappers and exposes the private index routine to the diagnostic process. No production files are instrumented. Active-index timings call the actual index routine on an already complete Sketch or Setup tree. Inactive-cold timings start before a fresh Lezer parse and end when the index returns. Cached-lookup timings call the real cached resolver and call-site matcher on the same state. There are 120 timed observations per component and fixture, with warm-up before each direct batch. Cache counts distinguish the original transaction and any forced recovery.
- **Runtime controls:** The harness runs one process at a time with a synchronous Bun GC before each batch, outside timing. Normal allocations and GC during a timed batch remain part of the runtime behavior. Assertions and edit construction are outside the timers.

These timings concern synchronous state and indexing work in Bun. Browser input latency, tooltip layout, paint, renderer throughput and 60 FPS require a separate hardware-accelerated browser validation.

## Recorded result

The application source and lockfile were unchanged from `c4e02af9dfdfcb830a662946d66905acf4fc94a7`. The raw artifacts are [paired state transactions](benchmarks/signature-assist-cpu-pairs.json.gz) and [component/index probes](benchmarks/signature-assist-cpu-probes.json.gz). The run recorded **24,192 A/B transactions**, **12,096 instrumented transactions**, and **1,440 direct component samples**. Each completion-assisted operation has 144 verified samples per arm and fixture. The replay aborted on any incorrect expected signature, parameter, documentation, or missing-hint state.

Runtime was Bun 1.4.5 on Linux 6.18.57 with an Intel Xeon Platinum 8573C, three visible CPUs, a two-CPU cgroup quota and an 8 GiB memory limit. The primary run saw 3 throttled periods out of 698 (0.43%). The probe run saw 5 out of 493 (1.01%). Locked versions were CodeMirror state 6.5.2, language 6.11.0, JavaScript 6.2.3, and Lezer common 1.2.3, JavaScript 1.5.1 and LR 1.4.2.

### Direct components

All durations are in milliseconds. Active rebuilds reuse a complete tree. Cold timings include the inactive Setup parse.

| Fixture | Component | Median | p95 | p99 | IQR | n |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| small | active-index | 0.0251 | 0.0713 | 0.1674 | 0.0073 | 120 |
| small | active-index-setup | 0.0262 | 0.1216 | 0.2751 | 0.0070 | 120 |
| small | inactive-cold | 0.2055 | 0.5156 | 0.7910 | 0.0949 | 120 |
| small | cached-lookup | 0.0024 | 0.0122 | 0.0694 | 0.0018 | 120 |
| medium | active-index | 0.2900 | 0.8127 | 1.2771 | 0.1282 | 120 |
| medium | active-index-setup | 0.3264 | 0.8604 | 1.2418 | 0.1584 | 120 |
| medium | inactive-cold | 2.8401 | 4.0087 | 5.0145 | 0.7091 | 120 |
| medium | cached-lookup | 0.0016 | 0.0061 | 0.0331 | 0.0010 | 120 |
| stress | active-index | 3.2035 | 7.8000 | 10.9726 | 2.4715 | 120 |
| stress | active-index-setup | 2.6944 | 5.8143 | 8.1109 | 0.9523 | 120 |
| stress | inactive-cold | 19.0598 | 26.6408 | 31.1716 | 3.4392 | 120 |
| stress | cached-lookup | 0.0022 | 0.0069 | 0.0282 | 0.0015 | 120 |

Active Sketch indexing median rose from **0.025 ms** to **0.290 ms** to **3.204 ms** as fixture size and declaration count increased. A cold inactive Setup build reached p95 **4.009 ms** for medium and **26.641 ms** for stress. Cached lookup p95 remained between **0.006 and 0.012 ms** through this size range. This only describes the tested cached calls and selection positions.

### Completion-assisted A/B

The table shows pooled p95 for each operation in milliseconds, with the absolute change in parentheses. Each cell compares 144 samples per arm. The summarizer reports full median/p95/p99, IQR, ready-only counts and all six per-pair deltas for every operation and policy.

| Operation | Small off → on (Δ) | Medium off → on (Δ) | Stress off → on (Δ) |
| --- | ---: | ---: | ---: |
| cursor | 0.012 → 0.034 (+0.023) | 0.003 → 0.007 (+0.004) | 0.004 → 0.015 (+0.011) |
| native-literal | 0.505 → 0.680 (+0.175) | 0.221 → 1.430 (+1.209) | 0.161 → 5.667 (+5.506) |
| custom-literal | 0.476 → 0.569 (+0.092) | 0.862 → 2.397 (+1.536) | 0.672 → 5.979 (+5.307) |
| nested-literal | 0.696 → 0.738 (+0.042) | 0.707 → 2.063 (+1.357) | 0.699 → 5.632 (+4.934) |
| helper-body | 0.442 → 0.453 (+0.011) | 0.663 → 1.986 (+1.323) | 0.622 → 5.804 (+5.182) |
| create | 0.533 → 0.648 (+0.115) | 1.305 → 2.274 (+0.969) | 1.277 → 5.796 (+4.519) |
| rename | 0.514 → 0.804 (+0.290) | 1.100 → 2.411 (+1.311) | 1.571 → 6.044 (+4.473) |
| delete | 0.591 → 0.622 (+0.031) | 1.214 → 2.990 (+1.776) | 1.509 → 7.374 (+5.865) |
| parameter | 0.368 → 0.569 (+0.201) | 0.913 → 2.103 (+1.190) | 1.209 → 9.938 (+8.729) |
| documentation | 0.521 → 0.466 (-0.055) | 0.575 → 1.991 (+1.416) | 0.751 → 6.188 (+5.436) |
| shadow | 0.498 → 0.562 (+0.064) | 1.289 → 2.043 (+0.754) | 1.176 → 5.970 (+4.794) |
| local-shadow | 0.466 → 0.545 (+0.078) | 0.174 → 1.137 (+0.964) | 0.166 → 5.978 (+5.812) |
| tab | 0.563 → 0.524 (-0.039) | 3.883 → 4.316 (+0.433) | 28.369 → 28.624 (+0.254) |
| slot | 0.555 → 0.603 (+0.048) | 3.621 → 4.318 (+0.697) | 24.274 → 32.713 (+8.439) |

The largest pooled delta was **+0.290 ms** for small and **+1.776 ms** for medium. Medium approached the provisional +2 ms budget, and some individual pairs exceeded it. Medium custom literal edits had medians **0.434 → 1.044 ms**, p99 **0.896 → 3.064 ms**, IQR **0.155 → 0.740 ms**, and per-pair p95 deltas from **+0.782 to +2.334 ms**. Medium rename reached **+3.854 ms** in one of six batches. The separate instrumented medium custom-literal path rebuilt the active index at p95 **1.505 ms**, consistent with indexing being a substantial cost on this path. Component measurements and A/B quantiles come from different samples and cannot be subtracted to attribute exact fractions.

At stress size, parameter changes added **+8.729 ms** p95 and changed slots added **+8.439 ms**. Warm slot and tab cases also have a substantial control cost because CodeMirror replaces and parses the document. Stress tab p95 was **28.369 ms** in the control and **28.624 ms** in the treatment.

### Parse deferral and cache counts

In the natural, viewless path, both arms deferred all 144 measurements per operation on medium and stress except full tab and slot replacements. Small had no deferrals. Medium natural tab and slot swaps had none. Stress natural tabs deferred **60/144 off and 66/144 on**. Stress natural slots deferred **26/144 off and 33/144 on**. In the completion-assisted path, stress tabs and slots still needed forced recovery on a subset of updates. The initial deferred work is retained as a separate category, with no credit for producing a valid hint.

The table gives instrumented active/inactive builds across 144 completion-assisted treatment samples per operation. The warm-up prepared the existing tab caches. Cold inactive parses were timed separately above.

| Fixture | Cursor builds A/I | Custom literal A/I | Docs A/I | Tab A/I | Slot A/I |
| --- | ---: | ---: | ---: | ---: | ---: |
| small | 0/0 | 144/0 | 144/0 | 0/0 | 144/0 |
| medium | 0/0 | 144/0 | 144/0 | 0/0 | 144/0 |
| stress | 0/0 | 144/0 | 144/0 | 0/0 | 144/0 |

### Review recommendation

Defer an indexing rewrite until the hardware-accelerated web benchmark. In this isolated runtime, representative pooled deltas stayed within the provisional budget, while individual medium batches, cold loads and stress workloads still justify tracing on target hardware. The previous SwiftShader findings concern a different runtime and include rendering contention.

If hardware traces identify indexing as a recurring bottleneck, review a bounded prototype that reuses records for unchanged top-level nodes and recomputes only affected records. The measured active index is the work available to save. Cold inactive parsing and full slot replacement would still carry their existing costs. A reasonable planning estimate is one to two engineering days for a prototype and one additional day for equivalence tests and rerunning benchmarks. Map retained positions through CodeMirror changes, and invalidate neighboring JSDoc associations, duplicate and shadowing state, and any declaration affected by parser recovery. Fall back to full indexing when affected scope is uncertain. Validate by comparing against the existing full index on fixture replays and seeded edit sequences that insert lines, move declarations, alter blockers, and add or remove JSDoc.

No indexing algorithm changes were made. The 638-test baseline, lint, build, and diff checks passed. The CPU results do not certify browser responsiveness, frame rate, Windows desktop, or Spout.
