# HYDRACTRL Desktop · experimental Ableton Link

Phase 2 promotes the Phase 1 pipe prototype into an optional desktop service. It uses Ableton Link 4.1.1 at `5ba907ae027a8c2ec8824463e37296dcefc5e9be` and standalone Asio at `8806a6803cde7054c3049d3666d3ec36786568c5`. The fork branch starts at `665250a` on upstream base `e494cfb`. [Phase 1 report](ABLETON_LINK_PHASE_1.md) · [Tracking issue](https://github.com/S4b40t/HYDRACTRL/issues/2)

## Operation and timing

Link is disabled on first launch. **Output → Ableton Link…** provides enable, quantum (1–16 beats), BPM, phase, peer count, helper status, and **Copy Link Diagnostics**. A running helper with zero peers is **Local timing**. Stale, starting, retrying, and unavailable states are reported independently. The companion executable is the only component that writes session tempo, in response to its preset buttons.

Electron main supervises one helper over private pipes. A version 1 snapshot replies to `sample [quantum]` every 50 ms. Changing quantum leaves discovery and the helper process running. A missing or invalid reply stops the child. Main retries failures with backoff from 250 ms to 8 s. Disable, app shutdown, and sleep close stdin and wait for exit, with a bounded termination fallback. Resume creates a fresh helper and clock epoch. Lost peers leave visuals free-running at the last tempo. Stale timing suppresses synchronization after 600 ms. [Helper protocol](../desktop/link-prototype/main.cpp) · [Supervisor](../desktop/src/main/linkService.js)

- The helper timestamps the anchor in Link’s monotonic host microseconds. Windows Link uses QPC. Electron main estimates an offset from the midpoint of its request to the helper and retains the lowest RTT among 20 recent measurements. The helper’s offset is reset on restart. Each renderer separately maps main’s timestamp onto its local `performance.now()` clock using the lowest RTT among eight recent responses. Subtract the offset to evaluate an anchor in main’s time domain. Clocks use monotonic time for phase. A wall-clock gap only helps invalidate renderer calibration after sleep; it never advances beats.
- Electron main publishes one corrected timing anchor. Both renderers project `elapsedUs / round(60_000_000 / bpm)` and wrap visual phase into the current quantum. New tempo updates change the rate from the new timestamp. For phase errors up to ⅛ beat, main slews the grid over half a second and reapplies this correction to the remaining error at each sample. Larger corrections, peer reacquisition, and quantum changes re-anchor the grid and increment a generation. The independent continuous beat value carries through re-anchoring. Synchronization is not reported throughout a stale period.
- Each `createBeatTrigger()` cursor keeps the highest boundary it has seen across grid generations. On a re-anchor or unsynced interval it updates that boundary, emits nothing, and retains the previous high-water mark so a backward correction cannot replay already crossed beats. On a generation change it also suppresses boundaries within half the shorter beat period of the last emission. Missed beats are not replayed. Visual envelopes can reposition once on a large correction.
- The editor and current offscreen `/output?primary` each pull from main through sandboxed preloads. Main matches the exact top-level WebContents and local route. Only the local settings document can configure Link or copy diagnostics. No timing is sent over the Bun output WebSocket. A reload or Spout restart creates a fresh renderer clock estimate and reads the same main service. [Clock projection](../desktop/src/shared/linkClock.js) · [Renderer client](../src/client/core/linkClient.js) · [IPC checks](../desktop/src/main/linkIpc.js)

## Sketch API

Use `globalThis.hydractrlLink` in a desktop sketch. It is installed before sketches run and does not inject a new local binding or replace an existing global of that name. Use optional chaining if the sketch also runs in a normal browser or a non-primary network output.

```js
const linkedPulse = () => globalThis.hydractrlLink?.pulse(0.25) ?? 0;
shape(4, 0.2).scale(() => 1 + 0.3 * linkedPulse()).out();
```

| API | Meaning |
| --- | --- |
| `read()` | One snapshot with `bpm`, continuous local `beat`, `phase` in beats, `normalizedPhase` in `[0,1)`, `quantum`, `peers`, `status`, and `synced` |
| `pulse(width = 0.25)` | Beat envelope from 1 to 0 over `width` beats |
| `wave(period)` | Sine-based cycle in `[0,1]`, using the quantum as the default period |
| `createBeatTrigger()` | Create once per effect. Call the returned function per update to get `null` or `{ downbeat }` when a new synchronized beat is reached |

Hydra `time` remains its elapsed animation time. FFT helpers continue to use audio energy by frequency. Link represents a shared musical clock and works without listening to audio. Local and stale states offer a free-running visual clock, with `synced: false` and no beat triggers. The test scene uses the same API, draws a four-beat teal/gold cycle when synchronized, and turns red when it is free-running. [Test scene](../src/client/plugins/linkTestScene.js)

## Build a local Windows Portable

For developers, use Windows x64 with Git, PowerShell 7.4+, Node.js 24, Bun 1.4.5, CMake 3.16+, and Visual Studio 2022 Build Tools with the C++ desktop workload and Windows SDK. From the feature branch’s repository root, run:

```powershell
bun install --frozen-lockfile
Push-Location desktop
bun install --frozen-lockfile
# If Electron is missing, run node node_modules/electron/install.js.
Pop-Location
pwsh -File desktop/scripts/build-link-portable.ps1
```

The script validates SDK revisions, stages a Windows directory build with the helper, and creates a labeled ZIP beneath `desktop/dist`. It stores the app and the companion peer in separate folders and generates the standalone scene from the built-in sample. The ZIP includes license notices, source archives for HYDRACTRL, Link and Asio, build inputs and exact revisions, and the tester guide. `-SkipZip` stops after staging an unpacked app for validation. Use `HYDRACTRL_LINK_TEST_PEER` with `desktop/scripts/smoke.mjs` in automation. The unpacked build uses an isolated profile under `%APPDATA%\HYDRACTRL Link Experimental`, an independent local server on port 13000 or the next free port, and a distinct default Spout sender. The normal installer and release workflow have no Link helper staging rule. [Build script](../desktop/scripts/build-link-portable.ps1) · [Acceptance guide](LINK_WINDOWS_TEST.md)

## Licensing and redistribution

HYDRACTRL is AGPL-3.0-only. Link is GPL-2.0-or-later on the public SDK terms. The proposed treatment for both SDK-bearing executables is to select GPLv3 for Link and combine the AGPLv3 application sources under AGPLv3 §13. Both parts retain their own licenses. Asio uses BSL-1.0. Treat the SDK-bearing programs as combined works for notices and Corresponding Source regardless of the pipes. The helper and peer use Windows OS networking and a static MSVC runtime for release builds. Retain Ableton’s notices, GPLv3, the app’s AGPLv3, Asio’s license, complete exact Link and Asio sources, and the build instructions. [AGPLv3 §13](../LICENSE) · [Pinned Link license](https://github.com/Ableton/link/blob/Link-4.1.1/LICENSE.md) · [Pinned Asio license](https://github.com/chriskohlhoff/asio/blob/8806a6803cde7054c3049d3666d3ec36786568c5/LICENSE_1_0.txt)

For the app bundle, Electron 45.0.0 is MIT with Chromium and other third-party notices in the Electron distribution. The compiled server uses Bun’s published license and notices. The locked texture-bridge packages are MIT and carry BSD-style Spout notices. The app fonts are OFL-1.1. The installed npm inventory also includes Hydra Synth 1.3.29 (AGPL per package metadata and its license) and p5 1.11.8 (LGPL-2.1 in its manifest). The packaging script collects the exact installed dependency version, declared license, notice files, and source repository, and retains the full app and lockfiles needed to rebuild. [Desktop lockfile](../desktop/bun.lock) · [App lockfile](../bun.lock) · [Font notices](../public/assets/fonts/LICENSE.txt)

**Hold external binary distribution pending maintainer review.** Several MIT packages in the installed inventory omit their license file, including the UIW themes. The app’s pre-existing random sketch banks aggregate third-party sketches. The project credits the collection, and the ZIP still needs confirmation of redistribution permissions for that content. Review LGPL obligations for bundled p5, the exact Chromium/Bun and texture bridge notices, the MSVC runtime terms, and the scope and delivery method for complete corresponding source and remote-use attribution. The branch provides source and a local build. No commercial license has been sought.
