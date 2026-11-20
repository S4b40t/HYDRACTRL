# Signature Assist Windows web validation

This runbook prepares the hardware gate for the browser build. It runs an isolated HYDRACTRL checkout with generated test fixtures and reports observations for review. The notebook run must be performed locally. Windows desktop, Electron, Resolume, and Spout are outside this test.

## 1. Prepare the notebook

- Close the normal HYDRACTRL application and any other heavy or rendering workloads. Leave its installation and data in place.
- Install Git, Node.js **24 LTS** (harness tested with 24.22.1), Bun **1.4.5** (tested version), and a current Microsoft Edge or Google Chrome. Playwright Core 1.63.0 comes from the lockfile. The launcher uses the installed browser binary and creates a separate automation profile. It does not use your regular browser profile.
- Plug in the notebook and record its current Windows power mode under **Settings → System → Power & battery**. Under **Settings → System → Display → Advanced display**, record the refresh rate of the display the benchmark window will use. Use a display already running at a steady 60 Hz for the reference comparison. If it is on a different or variable refresh rate, record that and treat the 60 Hz comparison as inconclusive.
- In your normal Edge or Chrome, `edge://gpu` or `chrome://gpu` shows **Graphics Feature Status** and the **GL_RENDERER** entry. Confirm WebGL says hardware accelerated. Windows Task Manager's **GPU engine** column and **Performance → GPU** identify which adapter a browser process is using. Note the adapter, display, brightness/power conditions if relevant, and any throttling or wake/sleep events. The benchmark independently records its actual profile's WebGL renderer and CDP GPU status. Browser-level inspection by itself does not establish the benchmark renderer.

## 2. Make a separate checkout

In PowerShell, paste the exact 40-character revision from the review comment on Issue #1 when prompted. Pick a new directory. Do not reuse the folder that serves your normal HYDRACTRL.

```powershell
$BenchRoot = Join-Path $HOME 'HYDRACTRL hardware benchmark'
$ExpectedRevision = Read-Host 'Paste the approved 40-character validation commit from Issue #1'
if (Test-Path -LiteralPath $BenchRoot) { throw 'Choose a new benchmark checkout folder' }
git clone --branch signature-assist-hardware-validation --single-branch https://github.com/S4b40t/HYDRACTRL.git $BenchRoot
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location -LiteralPath $BenchRoot
git checkout --detach $ExpectedRevision
if ($LASTEXITCODE -ne 0 -or (git rev-parse HEAD) -ne $ExpectedRevision) { throw 'Wrong revision' }
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Locked dependency install failed' }
node scripts/signature-assist-benchmark/check-platform.mjs
if ($LASTEXITCODE -ne 0) { throw 'Platform check failed' }
```

The launcher finds Edge or Chrome in standard machine/user install locations. To select a specific executable, set `$env:CHROMIUM` to its full path without embedded quotation marks. PowerShell example:

```powershell
# Optional. Check the actual path first.
$env:CHROMIUM = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

## 3. Run the pilot

```powershell
Remove-Item Env:HYDRACTRL_URL -ErrorAction SilentlyContinue
$env:BENCH_MODE = 'hardware'
$env:BENCH_PROFILE = 'pilot'
$env:BENCH_REVISION = $ExpectedRevision
$env:BENCH_PORT = '43127'
$env:BENCH_OUTPUT = Join-Path $BenchRoot 'hardware-pilot.json'
node scripts/signature-assist-benchmark/run.mjs
if ($LASTEXITCODE -ne 0) { throw "Pilot failed. Inspect $env:BENCH_OUTPUT before continuing." }
node scripts/signature-assist-benchmark/summarize.mjs $env:BENCH_OUTPUT
```

The launcher checks the clean tracked tree and pinned revision, builds the browser bundle with Bun, starts its own server on `127.0.0.1:43127`, checks the local and served SHA-256, and verifies the bundle the browser receives. An occupied port fails before launching Bun. Use a different unused `BENCH_PORT` if necessary. The benchmark rejects an external or existing server URL and disables the server's media folder. Browser storage and slots are generated in fresh Playwright contexts. No live banks, media, settings, credentials or Spout configuration are used. Result files stay local and existing files are not overwritten.

Expect several minutes for a pilot. Leave the visible benchmark browser on the intended display without covering, minimizing, or interacting with it. A failed renderer check reports **HARDWARE PREFLIGHT FAILED** and saves the available renderer evidence. SwiftShader, WARP, another software renderer, or an unconfirmed GPU cannot be labeled a hardware result. If the pilot succeeds, read the following checklist before starting a full run. The pilot is too short for a performance decision.

| Check | What to verify |
| --- | --- |
| Revision and served build | `provenance.testedRevision` equals the reviewed SHA. `appBundleSha256` and `servedBundleSha256` match. |
| Server and profile | The URL is the dedicated IPv4 loopback port. The normal app is closed and the Playwright browser is separate. |
| GPU and canvas | `preflight` records hardware classification, unmasked WebGL renderer/vendor, backend and 1280×720 canvas. Compare with the recorded GPU engine and display. |
| A/B and workload | Trials record Signature Assist active or unregistered, auto-run setting, checked tooltip content, actual draw calls, and successful run events. |
| Power, refresh and samples | Keep the same power/refresh/display conditions. The full-run disabled trials must demonstrate the reference cadence and collect enough intervals. Look at the summary's sample counts per pair and phase. |

## 4. Run the full comparison

```powershell
$env:BENCH_PROFILE = 'full'
$env:BENCH_OUTPUT = Join-Path $BenchRoot 'hardware-full.json'
node scripts/signature-assist-benchmark/run.mjs
if ($LASTEXITCODE -ne 0) { throw "Benchmark failed. Partial results are in $env:BENCH_OUTPUT." }
node scripts/signature-assist-benchmark/summarize.mjs $env:BENCH_OUTPUT |
  Set-Content -Encoding utf8 (Join-Path $BenchRoot 'hardware-summary.json')
```

Allow roughly **35–50 minutes** at the default 15-second idle and 15-second editing windows and five alternating pairs for each of the five settings. Duration depends on the notebook, browser launch, and the matched heap cycles. Small and medium run with auto-run off and on. Stress runs with auto-run off. Optional `BENCH_IDLE_MS` and `BENCH_EDIT_MS` can extend the windows to 30 seconds. `PAIRS` can increase the five-pair minimum. The browser stays visible, and idle/editing window timing, warm-up and scheduled edit lateness are recorded. The original generated fixture source is unchanged.

The primary arms run the same built bundle. A separate short diagnostic bundle counts active and inactive index builds with test-only instrumentation. Heap checks use matched medium runs, alternating control/lifecycle order over two pairs and 30 cycles per arm by default. Both arms perform the same source and tab edits. The lifecycle arm registers and disposes the plugin around those edits. Values are whole-renderer V8 heap after CDP GC. They vary with application history and other browser allocations. Evaluate patterns across repetitions before drawing a retention conclusion. Process RSS and GPU memory are outside this measurement.

### Read the results

- `hardware-full.json` contains schema version and run status, revision and hashes, browser/build/runtime provenance, per-context graphics checks, fixture sources, individual dispatch and rAF series, input and tooltip observations, sketch-run markers, diagnostic cache samples, and heap cycle results. `hardware-summary.json` contains per-pair and pooled median, p95, p99, IQR, counts and deltas. Recoverable failures are reported in the raw result file.
- Dispatch measures synchronous CodeMirror work. `beforeinput` to rAF and the tooltip mutation timestamp are estimates of browser scheduling and DOM availability. Frame intervals use rAF timestamps and long/missed-frame estimates. They do not measure GPU display presentation. A separate cold path samples first call selection before the ordinary typing sequence, and slot replacements and stress remain separate.
- For the 60 Hz review, each representative disabled idle/edit phase must sustain **58–62 rAF/s**, a **15.5–17.8 ms** median, at most **1%** intervals over 25 ms, and at least the larger of **600** or **50 intervals per measured second**. Software, pilots, incomplete runs and unstable controls yield an inconclusive gate. Look for repeatable **>5%** frame p95 deterioration, a representative incremental editor p95 above **~2 ms**, and continued heap growth after disposal across matched runs. A qualified control makes results eligible for review, it does not automatically pass the performance gate.
- Share `hardware-full.json` and the summary only after deciding to share. They may contain local executable/output paths and GPU details. Include monitor refresh, power mode, and GPU engine notes separately. A pilot or preflight failure is also useful to report.

## 5. Shutdown and cleanup

The launcher closes the browser and its dedicated Bun server on completion or failure. For an interrupted run, use Ctrl+C and allow the launcher to write its partial JSON. Check `Get-NetTCPConnection -LocalPort 43127 -State Listen -ErrorAction SilentlyContinue` (or the port you used). An unrelated listener should be left alone. Keep any results you intend to review, then remove only the separate benchmark checkout if you no longer need it. The normal installation is unaffected.

For a software comparison, use `BENCH_MODE=software` with a new output filename. The launcher explicitly uses headless SwiftShader and requires evidence of software rendering. These traces reproduce the software workload without serving as hardware results.

## Targeted Setup workflow

Use a clean checkout of the targeted harness commit. Preserve the original hardware run and pin the unmodified application baseline at `0a4c73ae546aba12996490d3734e25657d001373`. The targeted profile uses the reviewed Setup v1 file and a generated Sketch in a separate browser profile. Supply the original bytes via `BENCH_FIXTURE`. The loader verifies the approved SHA-256 before passing the fixture to the app and records its byte, character, and documented helper counts. Keep the file under an ignored directory such as `.bun/private-benchmark`. The app's normal CodeMirror editor handles line endings.

Run platform checks, `bun test`, `bun run lint`, `bun run build`, and the real-editor smoke script before collecting hardware timings. Point the smoke script at the isolated loopback server and installed Chromium binary. Use a dedicated port and disable media as in the benchmark launcher.

```powershell
$PrivateBench = Join-Path (Get-Location).Path '.bun\private-benchmark'
$env:BENCH_FIXTURE = Join-Path $PrivateBench 'HYDRACTRL_Setup_v1.js'
Get-FileHash -Algorithm SHA256 -LiteralPath $env:BENCH_FIXTURE
$env:BENCH_REVISION = (git rev-parse HEAD).Trim()
$env:BENCH_MODE = 'hardware'
$env:BENCH_PORT = '43127'
Remove-Item Env:HYDRACTRL_URL -ErrorAction SilentlyContinue
$env:BENCH_PROFILE = 'targeted-pilot'
$env:BENCH_OUTPUT = Join-Path $PrivateBench 'targeted-pilot.json'
node scripts/signature-assist-benchmark/run.mjs
if ($LASTEXITCODE -ne 0) { throw 'Targeted pilot failed' }
node scripts/signature-assist-benchmark/summarize.mjs $env:BENCH_OUTPUT
```

After reviewing the pilot, run the full targeted matrix while the display is available for the visible browser. It takes approximately 25–40 minutes, depending on the notebook and snapshot option. The pilot takes a few minutes.

```powershell
$env:BENCH_PROFILE = 'targeted'
$env:BENCH_OUTPUT = Join-Path $PrivateBench 'targeted-baseline.json'
# Optional. Collect snapshots in fresh contexts after the regular heap arms.
# $env:BENCH_HEAP_SNAPSHOTS_DIR = Join-Path $PrivateBench 'baseline-snapshots'
node scripts/signature-assist-benchmark/run.mjs
if ($LASTEXITCODE -ne 0) { throw "Inspect partial results in $env:BENCH_OUTPUT" }
node scripts/signature-assist-benchmark/summarize.mjs $env:BENCH_OUTPUT |
  Set-Content -Encoding utf8 (Join-Path $PrivateBench 'targeted-baseline-summary.json')
```

The primary matrix runs the real Setup with auto-run off and on, plus the original synthetic stress case with auto-run off. Each setting uses five alternating pairs and 15-second Sketch idle and editing windows. Native, custom and nested Sketch edits retain separate dispatch samples. The real fixture also exercises five active Setup edit types for a combined 15 seconds, with a separate timing series per type. It verifies valid and recovered hints and clears the temporary Setup declarations after each type. The malformed phase runs without triggering auto-run. Warm tab switches and changed slots have separate timing series.

The diagnostic bundle runs after the primary trials and records counts and timing by phase, tab and operation. Component ranges may nest and include measurement overhead. Use them to locate work and compare hit/miss frequency. Use the primary bundle for absolute latency and frame comparisons. Matched heap arms warm each context before recording 60 cycles per arm. The optional snapshot switch uses two additional fresh contexts and captures snapshots before warm-up, after warm-up and after disposal. Raw traces and snapshots can contain source, fixture text, and local paths. Keep them local and share aggregate results.
