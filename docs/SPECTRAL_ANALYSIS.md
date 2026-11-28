# Spectral analysis

HYDRACTRL can expose frequency ranges in Hz through the existing `a.fft` array. Each range produces one control value. Sketches and Setup helpers such as Biotech's `audioLevel(0)` and `audioAverage([0, 1])` can read the array as before.

## Sketch API

```js
a.setBandRanges([
  [20, 60],
  [50, 150],
  [120, 500],
  [400, 2000],
  [1500, 5000],
  [4000, 16000]
])

osc(8, 0.1, () => 0.1 + a.fft[0]).out()
```

| Method or property | Behavior |
| --- | --- |
| `a.setBandRanges(ranges)` | Accepts 1–64 pairs of finite numbers with `0 <= low < high <= sampleRate / 2`. Bounds can be fractional. The order determines the index in `a.fft`. Malformed input throws before replacing the active configuration. The cap keeps per-band state, visualization, and output replay messages bounded. |
| `a.getBandRanges()` | Returns a deep copy of the active pairs, or `null` in legacy mode. |
| `a.clearBandRanges()` | Restores the previous legacy bin count and settings. The legacy meter starts from silence. Repeated calls in legacy mode have no effect. |
| `a.setBins(n)` | Selects Hydra's original binning and initializes `n` legacy bins using the current global controls. Biotech v1.4.1's `a.setBins(3); a.setSmooth(0.85)` restores its baseline each time the Setup executes. A range declaration later in the same run takes effect afterward. |
| `a.fft[i]` | In custom mode, reports a finite level from 0 to 1. Legacy values retain Hydra's original scaling, which can exceed 1. |
| `a.show()` and `a.hide()` | Toggle the same bottom-right meter. Custom mode draws the exposed levels in sketch order. Hover over the meter to see the indexed Hz ranges. |
| `a.onBeat` | Uses the original Meyda total loudness, adaptive threshold, and frame timing in either mode. |

Bands may overlap, leave gaps, appear in any order, and repeat. A 70 Hz tone contributes independently to both `[20, 80]` and `[50, 150]`. Identical ranges with the same controls and history produce identical values. An identical range declaration retains the current meter and history. A changed declaration resets the custom smoothing history and initializes each band's controls from the global values.

```js
// Frequency order is up to the sketch.
a.setBandRanges([[50, 150], [20, 80], [120, 250], [50, 150]])
a.setSmooth(0.45)
a.setCutoff(0.5)
a.setScale(8)
a.settings[2].scale = 6
```

`setSmooth`, `setCutoff`, and `setScale` apply to every band. Advanced sketches can also change `a.settings[i].smooth`, `.cutoff`, and `.scale`. Global setters made in custom mode also affect the saved legacy settings. Per-band overrides apply to the active configuration. Custom mode clamps smoothing between 0 and 0.999, with 0 using the latest frame immediately. It treats a negative cutoff as zero and uses a span of 10 for a nonpositive or nonfinite scale. A nonfinite cutoff or smoothing value is treated as zero. These custom safeguards keep the output bounded and let silence decay even with high smoothing.

## Input and renderer architecture

HYDRACTRL locks Hydra Synth 1.3.29 and Meyda 5.6.3. Hydra creates an AudioContext on microphone acceptance, opens one MediaStreamSource, and constructs a Meyda analyzer. HYDRACTRL's input manager handles that original microphone request, resolves the chosen device by ID or label, and switches the existing Meyda analyzer to a new source on device changes. If a chosen device disappears, it tries the default and returns to the selection when that device comes back.

Meyda uses a 512-sample Hann window and produces 24 Bark-band loudness values. Hydra groups the Bark values in consecutive chunks of `floor(24 / n)`, sums each chunk, applies its per-bin exponential smoothing, and exposes `max(0, (bin - cutoff) / scale)`. The upstream constructor starts with four bins. Beat detection consumes Meyda's total loudness independently of the current bin count, with an adaptive threshold and a frame-based hold and decay. The legacy bin and beat algorithms stay in Hydra.

Meyda can return an amplitude or power spectrum alongside loudness from the same extraction. At 48 kHz its 512-point spectrum has 93.75 Hz coefficient spacing. Increasing Meyda's window would also change the amplitude input and timing of the existing beat detector. Custom mode instead taps the same MediaStreamSource with one native Web Audio AnalyserNode and reads it once per active renderer tick. The 4096-point FFT supplies the bass resolution while the original Meyda path continues to supply the beat. The AnalyserNode output stays disconnected, so there is no audible monitoring.

The small Bun patch to Hydra exposes its source, lets it reuse an AudioContext created by the new range API, and adds a hook after the original loudness and beat processing. This enables synchronous Nyquist validation before microphone permission resolves and ensures mode changes from inside `onBeat` take effect in the same frame. The AnalyserNode is created only when custom ranges, live input, and a running context are available. It is reused across range edits, disconnected when leaving custom mode or losing the source, and reattached to the new source on recovery. Old stream listeners and tracks are released, and closing a render head stops its render loop and closes its context. The feature adds no dependencies. The patch follows Hydra Synth's existing AGPL licensing.

The editor and `/output` renderers install the same API. The WebSocket relays the input choice separately from sketch code. The desktop primary renderer queues Setup and main code in the original order, and the editor mirrors its frames while pausing its own render loop. Spout receives textures from that primary Chromium renderer. Successful sketch messages carry the ranges in force **before** execution so that a fresh output can replay a scene that inherited ranges from an earlier run. The replay applies the starting ranges before Setup, allowing Setup and main code to override them in order. When the desktop falls back to local rendering it can replay the same baseline. On a single renderer, configuration persists between runs until a sketch calls a range setter or `setBins`. For portable scenes, put custom ranges and desired smoothing, scale, cutoff, or per-band settings in the scene or its Setup. Replay carries the ranges, while control values and other mutable sketch state follow the code that runs on each renderer.

## Measurement and normalization

Web Audio supplies float dB values from the Blackman-windowed FFT with analyzer smoothing disabled. The meter converts each included coefficient to linear power. It weights boundary coefficients by the fraction of their frequency cell inside the range and measures each band independently. It doubles positive-frequency power for the implied negative-frequency half of the spectrum and corrects for the Blackman window's mean-square gain of 0.3046. Taking the square root gives an approximate RMS amplitude, and multiplying by 100 puts it into the meter's control units.

An isolated tone contained in either a narrow or wide band produces approximately the same level. Integrated power reflects additional broadband energy when it actually falls inside a wider band. This preserves sensitivity for narrow bass bands while avoiding the coefficient-count bias of a raw magnitude sum. Averaging energy by bandwidth would give the same isolated tone a lower value in a wider band. Smoothing operates once per renderer frame on these control units, then the output applies `clamp((smoothed - cutoff) / scale, 0, 1)`. At the default cutoff of 2 and scale of 10, steady values start rising above approximately 0.02 RMS and reach full scale near 0.12 RMS. Device gain, mic processing, clipping, and the window's transient response affect readings.

Frequency-to-coefficient mapping and edge weights are calculated when the ranges are configured using the context's actual sample rate. An AudioContext keeps that rate when a replacement device connects. A new context builds its own mapping. One reusable float buffer holds the raw dB data. A reusable prefix sum of coefficient powers gives each band its interior power in constant time. The custom metering loop allocates no arrays per frame.

## Resolution and limitations

Chromium's OfflineAudioContext measured the same 70 Hz sine at amplitude 0.1 using each candidate FFT size at 48 kHz. The leakage column is the approximate RMS response in Scene A's nearby `[20, 60]` band divided by the response in `[50, 150]`. The wide-band RMS is near the theoretical 7.07 control units at 4096 samples.

| Samples | Hz per coefficient | Window in ms | Leakage ratio | Wide-band control units |
| --- | ---: | ---: | ---: | ---: |
| 1024 | 46.88 | 21.33 | 0.744 | 6.99 |
| 2048 | 23.44 | 42.67 | 0.538 | 7.06 |
| 4096 | 11.72 | 85.33 | 0.376 | 7.07 |

4096 samples gave the strongest separation of the candidates. Brief transients are spread across the longer look-back window, and higher frame smoothing adds further lag. Actual visual latency also depends on capture and frame timing. Near a boundary or in a very narrow band, expect partial responses and leakage into nearby bands. Fractional weights smooth boundary transitions at the limits of the FFT's resolution. Web Audio omits the coefficient centered exactly at Nyquist. At the top edge, ranges use the last available coefficient. The FFT size is fixed to keep the API and timing predictable.

## Verification and performance

| Check | Result |
| --- | --- |
| `bun test` | 542 passed. Covers frequency selection, overlap and duplicates, multiple signals, validation and Nyquist, custom smoothing, legacy restoration, beat callbacks, source loss and recovery, and output replay. |
| `bun run lint` and `bun run build` | Both passed. |
| `desktop/scripts/smoke.mjs --dev --software-gl` | 35/35 passed with Electron 45 on Linux under Xvfb. The smoke checked the platform's graceful lack of native texture sharing. |
| `scripts/spectral-smoke.mjs` | Passed with real Chromium Web Audio and synthetic inputs through the editor and primary output. Verified input selection and recovery, range restoration on output restart, context and track disposal, intensity, and all four diagnostic sketches. |
| Windows x64 unpacked package | Cross-built with Electron 45 and the compiled Bun server. Verified that the package contains the Windows Spout binding. Windows launch and hardware checks are pending. |

To reproduce the browser tests, start `bun run dev` in one terminal, then run the following in a second. Playwright looks for its Chromium installation by default. Set `SPECTRAL_CHROMIUM` to use a local Chromium binary.

```sh
SPECTRAL_CHROMIUM=/usr/bin/chromium bun scripts/spectral-smoke.mjs http://127.0.0.1:3000 --benchmark
```

The following measurements use Chromium 156.0.8078.79 on a Linux x64 cloud VM on an AMD EPYC 9V74, with SwiftShader, one 1280×720 output page, a semi-transparent solid shader, the audio meter hidden, and an active synthetic 1 kHz input. The live audio context ran at 44.1 kHz. The script times 120 animation frames per mode after 40 warm-up frames. Audio tick time includes the Meyda read, beat detection, and any native spectrum read and band processing on the renderer thread.

| Mode | Mean audio tick (ms) | 95th percentile (ms) | Animation frames/s |
| --- | ---: | ---: | ---: |
| Legacy 3 | 0.173 | 0.300 | 30.6 |
| Custom 3 | 0.436 | 1.000 | 29.6 |
| Custom 6 | 0.347 | 0.400 | 32.2 |
| Custom 24, geometric spacing | 0.375 | 0.600 | 31.5 |

The measured additional mean audio tick time was 0.17–0.26 ms. The covered frequency span affects work as well as the number of bands. The animation rates show throughput in this software-rendering session. Native texture sharing and audio-thread CPU usage were outside this measurement.

The Windows Spout sender, receiver alpha compositing, USB-device behavior, and sustained 1280×720 at 60 FPS remain physical validation targets.

## Windows notebook diagnostics

For the unpacked Windows test build, extract the ZIP to a writable folder and run `HYDRACTRL.exe`. The build is unsigned. A `Diagnostics` folder in the ZIP contains the sketches and test WAV. For a source checkout, install Bun and run the following in PowerShell, starting at the repository root. If Electron's binary is missing after install, run `node node_modules/electron/install.js` in `desktop` and retry.

```powershell
bun install --frozen-lockfile
Set-Location desktop
bun install --frozen-lockfile
bun run start
```

1. Expand the System panel and choose the input under **AUDIO INPUT**. Play the diagnostic WAV through your existing loopback, Stereo Mix, or audio interface. A microphone also works, but laptop speakers and mic processing may strongly attenuate the lowest and highest tones.
2. Paste each sketch into the Main tab and press **Ctrl+Enter**. Use the same WAV and playback level for all four sketches. Leave your usual Setup in place if you want to verify that the Main tab can override its three-bin baseline. To test legacy restoration afterward, run `a.setBins(3); a.setSmooth(0.85)` with a Main tab that does not set ranges.
3. Run [Scene A](spectral-analysis/scene-a-frequency-separation.js) and watch the six columns left to right. Run [Scene B](spectral-analysis/scene-b-overlapping-bands.js) to see red and amber light up together at 70 Hz, then amber and green at 135 Hz. Compare [Scene C legacy](spectral-analysis/scene-c-legacy.js) and [Scene C custom](spectral-analysis/scene-c-custom.js) using the same input.
4. Start Spout while Scene A or B is running. Set **720p**, **60 fps**, and **Include alpha** in the output settings. Check the same activity in a Spout receiver, stop and start output again, then switch input in the System panel while playback continues. Compare the measured output frame rate and dropped frames in the receiver.
5. Check receiver alpha over a contrasting background using this sketch. The square's opacity should rise with the selected audio band, while the surrounding area stays transparent.

```js
a.setBandRanges([[50, 150]])
a.setCutoff(0.3)
a.setScale(7)
a.hide()
solid(1, 0.35, 0.1, () => 0.15 + 0.85 * a.fft[0])
  .mask(shape(4, 0.4))
  .out()
```

Generate the 28-second mono PCM WAV from the repository root with `bun docs/spectral-analysis/generate-audio.mjs spectral-diagnostics.wav`. Play at a comfortable level. Timing includes brief fades around each section.

| Time | Source | Expected custom response |
| --- | --- | --- |
| 0:00–0:02 | Silence | Both meters decay toward zero. |
| 0:02–0:03.5 | 36 Hz | Scene A red. Scene B red. |
| 0:03.5–0:05.5 | 70 Hz | Scene A amber with some red leakage. Scene B red and amber. |
| 0:05.5–0:07.5 | 135 Hz | Scene A and B amber and green. |
| 0:07.5–0:09 | 300 Hz | Scene A green, Scene B quiet. |
| 0:09–0:10.5 | 1000 Hz | Scene A cyan. |
| 0:10.5–0:12 | 3200 Hz | Scene A blue. |
| 0:12–0:13.5 | 7500 Hz | Scene A magenta. |
| 0:13.5–0:15 | 18 kHz | Outside the Scene A and B ranges. |
| 0:15–0:17 | 70, 1000, and 7500 Hz | Scene A amber, cyan, and magenta. Scene B red and amber. |
| 0:17–0:22 | Log sweep from 30 Hz to 12 kHz | Scene A progresses left to right with overlapping activity at transitions. |
| 0:22–0:26 | 1000 Hz, rising amplitude | Scene A cyan brightens, then can saturate depending on input gain. |
| 0:26–0:28 | Silence | Both meters settle. |

## Integration and review

The feature starts at `e494cfbb246c53ebe4f05f4527f2e4498e117fca` on `main`. At inspection, `integration/portable-midi-signature-link` branched from the same commit and was 22 commits ahead. The read-only diff identifies potential conflicts in `index.js`, `output.js`, `sketchRunner.js`, `primaryRunner.js`, `DesktopMirrorPlugin.js`, `OutputSyncPlugin.js`, and `outputHub.ts`. Those paths carry sketch execution, parameter and Link state, and output protocol changes. During eventual integration, preserve both parameter and range baselines, the primary renderer's queued runs and deduplication, Setup-before-Main order, and the audio device messages. Check that the root Bun install still applies the Hydra patch when building the Portable. The spectral engine and diagnostic assets are isolated from the existing feature implementations.

| Area | Files |
| --- | --- |
| Added spectral engine and dependency patch | `src/spectralRanges.ts`, `src/client/core/spectralAudio.js`, `src/client/core/spectralBands.js`, `patches/hydra-synth@1.3.29.patch` |
| Updated dependency metadata and input lifecycle | `package.json`, `bun.lock`, `src/client/core/audioInput.js` |
| Updated renderer and sketch replay | `src/client/index.js`, `src/client/output.js`, `src/client/core/sketchRunner.js`, `src/client/core/primaryRunner.js`, `src/client/plugins/BreakoutPlugin.js`, `src/client/plugins/DesktopMirrorPlugin.js`, `src/client/plugins/OutputSyncPlugin.js`, `src/server/outputHub.ts` |
| Added or extended automated verification | `src/client/core/spectralAudio.test.js`, `src/client/core/audioInput.test.js`, `src/client/core/primaryRunner.test.js`, `src/server/outputHub.test.ts`, `scripts/spectral-smoke.mjs` |
| Added documentation and diagnostics | `docs/SPECTRAL_ANALYSIS.md`, four `scene-*.js` sketches and `generate-audio.mjs` under `docs/spectral-analysis/` |
