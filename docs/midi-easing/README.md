# MIDI easing diagnostic

## Asymmetric articulation

Run [articulation.js](./articulation.js) in **Sketch** in an isolated profile
or a scratch slot. Bind three momentary CC buttons to **Slow attack button**,
**Slow release button**, and **Independent easings**. Bind a knob to
**Asymmetric knob** and cross its starting value to pick it up.

- Hold each button through its attack, release early, then press again
  during the release. Watch for a reversal from the current marker position.
- Turn the knob quickly in both directions and pause at a midrange value.
- Compare the equal durations on **Independent easings**. The rising marker
  eases in and out, and the falling marker moves quickly at the start.
- Override either side in **MIDI mappings**, then recall the slot or restart
  the app and verify the saved fields. Use **Reset parameter values** to
  recover from a release the device did not send.

## Easing comparison

Paste [setup.js](./setup.js) in **Setup** and [sketch.js](./sketch.js) in
**Sketch**, then save and run the sketch in a slot. Open **MIDI mappings** and
learn a separate absolute CC for each row. The Virtual UC-33 HYDRACTRL preset
can use K01–K06 in order.

| Lane from top | Parameter | Duration |
| --- | --- | --- |
| 1 | Linear | 100 ms |
| 2 | Smoothstep | 400 ms |
| 3 | Ease in | 400 ms |
| 4 | Ease out | 100 ms |
| 5 | Ease out power 4 | 400 ms |
| 6 | Elastic | 600 ms |

Each marker's horizontal position represents its current value. The diagnostic
also exposes the same six getters in `globalThis.midiEasingDiagnostic` for
inspection. Soft Takeover is enabled. Move each control through its initial
value of 0.2.

1. Send one CC change and pause. Verify the marker settles. Aim the elastic lane
   at a midrange value so the overshoot has room to show.
2. Turn each knob continuously and reverse direction quickly. Compare the lag on
   the longer slow-start curves with the shorter lanes.
3. Recall another slot and return. Verify the markers reset to 0.2 and the
   saved mappings pick up each parameter again.
4. If using a primary output page or Spout receiver, watch the same lanes while
   repeating the checks.
