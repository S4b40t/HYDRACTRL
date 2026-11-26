# MIDI easing diagnostic

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
