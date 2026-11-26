# HYDRACTRL MIDI easing development report

Windows notebook, November 25, 2026.

| Revision | Branch | Commit |
| --- | --- | --- |
| Base, verified against GitHub | `feature/midi-control-system` | `3c5aae22c8a798282c4496a50c9a469d8fb204a1` |
| Implementation, documentation, diagnostic and regression checks | `feature/midi-eased-smoothing` | `3822f5ae20317eb54fa76f30e52c430070f0f38e` |

This report follows the implementation commit on the dedicated local branch.

## API and implementation

`midiParam(name, { default, min, max, smoothing, curve, takeover, easing })`
accepts an optional synchronous JavaScript callback for normalized transition
progress. `curve` maps the controller to a target, `smoothing` sets the duration,
and `easing` interpolates between values over that duration. The getter reaches
the exact target at completion and uses the exact starting value at time zero.
It clamps eased values to `min` and `max`, allowing overshoot of an interior
target. Omitting the callback gives linear interpolation. Zero smoothing and
immediate restoration bypass the callback.

Registration checks the callback type. A throw or invalid sample uses linear
progress for that sample, silently. A new target samples the previous
transition at the timestamp it starts the replacement, while duplicate targets
leave its timing intact. The MIDI mapping, pickup, recall and recovery paths
continue to use the existing definition and target contracts.

Each renderer captures its callback when it runs Setup and Sketch. Parameter
definitions contain serializable fields and target messages contain numeric
values associated with the sketch run. MIDI banks use their existing format.
Callbacks can close over Setup variables or call ordinary JavaScript helpers.
The work has no Biotech dependency.

## Automated checks

| Check | Result |
| --- | --- |
| Standalone base | 540 passed, 3 macOS-only skips. Client build and existing MIDI browser smoke passed before implementation. |
| `bun test` on the feature | 555 passed, 3 macOS-only skips. |
| `bun test src` from `desktop/` | 90 passed. |
| `bun run lint`, `bun run build`, `git diff --check` | Passed. |
| `node scripts/midi-smoke.js` | Passed in Chrome. Covers legacy and curved transitions, six independently learned diagnostic bindings, exact endpoints, overshoot, scene recall and numeric updates across the output WebSocket. |
| Deterministic unit coverage | Linear and custom timings, exact increasing and decreasing endpoints, zero duration, type validation, throws and invalid results, hard bounds, repeated and reversing targets, immediate restore, Soft Takeover, and independent renderer reconstruction with structured-cloneable definitions. |

The baseline and feature suite ran with localhost and Windows symlink access.
Client dependencies came from a local checkout with the same locked versions.
The unrelated Hydra audio patch was reversed in the copied dependency to
match the MIDI branch.

## Notebook acceptance

- **Simulated MIDI in the browser.** The existing navigation, device recovery,
  bank export/import and failed-recall recovery smoke passed. The six-lane
  diagnostic confirmed both short and long transitions on the editor and the
  primary output page, including functions defined in Setup.
- **Simulated MIDI in Electron 45.** In a disposable profile, six separate
  controls learned and picked up independently. An isolated CC 76 step settled
  at `0.598425` in all lanes. The elastic lane peaked at `0.728577`. A burst
  with rapid reversals stayed within bounds and settled at CC 15 in all lanes.
  Recalling through the MIDI navigation mappings reset the six values to 0.2.
  Pickup was rearmed on return.
- **Windows virtual MIDI in Electron 45.** Drove the unmodified Phase 1
  emulator's controller through its HYDRACTRL preset and real WinMM output,
  using the notebook's existing `UC-33` loopMIDI port. A separate WinMM
  monitor checked the bytes while Electron received them through Web MIDI.
  K01–K06 learned independently on channel 3. For example, K01 at 76 sent
  `B2 10 4C`. The 100 ms linear lane settled ahead of the 400 ms ease-in lane,
  and the elastic lane peaked at `0.728315` for the CC 76 target `0.598425`.
  Rapid rotary sweeps and reversals settled exactly at CC 15 in all lanes.
  A repeated emulator value generated no packet, and K10 and B01 recalled
  the two scenes and rearmed pickup. The test drove the emulator's controller
  programmatically.
- **Spout.** An independent native texture receiver obtained 123 distinct
  640 × 360 frames in the simulated MIDI run and 114 in the matching actual
  virtual MIDI run. Each frame sampling window lasted about 2.4 seconds. The
  sender reported 60 FPS and zero dropped frames at the final virtual MIDI
  check. The offscreen primary screenshot showed all six markers.
- **Physical MIDI.** No physical UC-33 input appeared. Knob feel, physical
  reconnection and pickup remain unverified on the controller.

## Responsiveness and runtime cost

A deterministic full-range ramp sent 36 distinct CC targets at 60 Hz with
400 ms smoothing. When the last CC reached 127, the displayed values after
one more input interval were 0.499 for linear, 0.088 for smoothstep, 0.031 for
quadratic ease-in, and 0.702 for quadratic ease-out. Each reached 1.0 after
the final transition completed. Replacing a transition preserves its value,
with a possible change in slope. Slow-start curves with long smoothing can
lag during a sustained turn. Shorter durations or an ease-out curve improve
tracking while retaining smoothing.

A Chrome 158 microbenchmark on the i7-6700HQ measured median getter costs of
25.9 ns for base linear, 31.5 ns for feature linear, and 39.5 ns for feature
smoothstep. It used nine interleaved runs of 6.4 million active getter calls
per mode with a deterministic clock. The measured smoothstep increment over
feature linear was about 0.5 µs per frame at 64 active getters sampled once
each. These timings isolate getter work. More expensive custom callbacks and
multiple reads per frame add their own cost.

## Integration

Review the feature commit against `feature/midi-control-system`. For a local
integration on a descendant of that base, cherry-pick the implementation
commit and run the checks above. For an upstream submission, carry the MIDI
Control System prerequisites with the feature. The [MIDI guide](../MIDI.md)
describes the API and the [diagnostic](./README.md) gives a manual acceptance
sequence. The branch is local. No integration branch was updated and no
binary was published.
