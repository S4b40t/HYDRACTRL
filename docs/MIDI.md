# MIDI control

Expand **System**, select a MIDI input, and open **MIDI mappings**. The selected
input and its navigation profile are saved in HYDRACTRL. If a selected input
disconnects, HYDRACTRL waits for it to return. At launch a changed MIDI port ID
can be recovered when exactly one input matches the saved manufacturer and name.
During a session, explicitly select the matching replacement to recover its
profile after an ID change. Choose **Automatic MIDI input**
to use an available device, or explicitly select the replacement input.

## Set up a UC-33 or another controller

| Control | MIDI mappings row | What to do |
| --- | --- | --- |
| Rotary knob | Pending slot | Click **Learn** and turn the knob. Use absolute CC with a 0–127 range. |
| Lower-right button | Confirm pending slot | Click **Learn**, press the button, and release it. |
| Two buttons | Previous pending bank and Next pending bank | Learn each button separately. |
| Optional knob | Pending bank (selector) | Learn an absolute CC to select one of the four banks directly. |
| Other knobs or faders | Sketch parameters | Learn them after saving and running a sketch with parameter declarations. |

HYDRACTRL records the message type, channel, and number from the controller.
The navigation profile starts with empty assignments. Leave spare buttons
unassigned. For a button that sends a high CC on press and a low CC on release,
use the default momentary mode. For a latching button that sends 0 and 127 on
alternate presses, select **Use toggle** on its mapping row. Buttons that send
Note On and Note Off can be learned too.

The selector divides the dial into 16 equal ranges. The slots panel shows the
pending slot and bank numerically, with a dashed outline on the pending slot
in the current bank or on the pending bank dot for another bank. Previous and
next wrap across the four banks and retain the pending slot number. If you
browse banks before moving the selector, browsing starts from the active slot
number. Confirm recalls the pending sketch and clears the pending selection.
Confirming an empty slot leaves the current sketch playing. Pending markers
are interface-only.

Clicking a slot, using a keyboard shortcut, or recalling a slot from a legacy
MIDI Note On still recalls it immediately. Generic Note On retains its
existing slot mapping when the note has no explicit assignment. The nanoPAD2
keeps its saved pad notes, scene following, and XY controls. Its pad notes and
XY controls are reserved. Use **Learn pad for active slot** in the nanoPAD2
profile to edit a legacy pad assignment.

Use **Learn** to replace a binding, **Clear** to remove it, or **Reset navigation**
to clear the selected input's navigation profile. If a bank contains a sketch
assignment that shares a control with a global action, the global action takes
precedence and the sketch row shows the conflict.

## Declare parameters in the Sketch tab

```js
const depth = midiParam("Distortion depth", {
  default: 0.12,
  min: 0,
  max: 0.5,
  smoothing: 80,
});

osc(20).modulate(noise(3), depth).out();
```

`midiParam(name, options)` registers a named parameter during sketch execution and
returns a getter. Pass the getter where Hydra accepts a dynamic value, or
compose it in another getter such as `() => 1 + depth()`. The name must be
unique within the sketch. A sketch can declare up to 64 parameters. Required
options are `default`, `min`, and `max`, with the default between the bounds.
Optional settings are:

| Option | Default | Behavior |
| --- | --- | --- |
| `smoothing` | `0` | Time in milliseconds to reach the new target from the current value. |
| `easing` | Linear | Optional JavaScript function that shapes progress during a smoothed transition. |
| `curve` | `1` | Exponent on the normalized CC value. For example, `2` gives finer control at the low end. |
| `takeover` | `true` | Catch or cross the current value before the control changes the parameter. Set to `false` for immediate absolute control. |

For a feedback sketch such as Tidal Memory, the same physical knob can
instead learn a parameter named `"Feedback persistence"` with a range suitable
for that sketch, for example `{ default: 0.92, min: 0.6, max: 0.99 }`. A mapping
belongs to a saved bank slot and its parameter name. The current parameter
values start from the sketch defaults on recall. Move a physical knob through
the new sketch's value to pick up control.

Save and run the sketch in a slot before learning its parameters. The
assignments persist when reopening HYDRACTRL and travel with the sketch in a
bank export. An imported older bank file needs no MIDI metadata. Exported
bindings identify the CC and channel, and can be relearned if the destination
controller uses different settings.

On desktop, HYDRACTRL sends parameter targets to the active output renderer
using the sketch execution's ID. The renderer updates its existing getters.
The browser's local renderer, breakout, and connected output pages can use the
same parameters. MIDI input and navigation are managed by the HYDRACTRL
application.

## Shape the transition

`curve` maps the physical CC position to a target. `smoothing` sets how long the
transition to that target takes, from 0 to 60,000 ms. `easing` shapes how the
value moves over that time. At `smoothing: 0`, changes are immediate.

Declare reusable functions in **Setup**:

```js
const smoothstep = t => t * t * (3 - 2 * t);
const easeIn = t => t ** 2;
const easeOut = (t, power = 2) => 1 - (1 - t) ** power;
const elastic = t => 1 - (1 - t) ** 3 * Math.cos(3 * Math.PI * t);
```

Use them in the **Sketch** tab:

```js
const range = { default: 0.2, min: 0, max: 1, smoothing: 200 };
const linear = midiParam("Linear", range);
const smooth = midiParam("Smoothstep", { ...range, easing: smoothstep });
const slowStart = midiParam("Ease in", { ...range, easing: easeIn });
const fastStart = midiParam("Ease out", { ...range, easing: easeOut });
const rotation = midiParam("Rotation", {
  ...range, default: 0, min: -1, easing: t => easeOut(t, 4),
});
const bounce = midiParam("Elastic", { ...range, smoothing: 600, easing: elastic });
```

Use pure, synchronous callbacks that return a finite number. HYDRACTRL passes
normalized progress inside the transition. It uses the exact start and target
values at the endpoints. A throw or invalid return uses linear progress for that
sample. For an overshoot, aim at a target inside the parameter range, such as
0.6 with bounds of 0 and 1. The output stays within `min` and `max`.
Each renderer runs the same Setup and Sketch to create its own callback.

When a knob sends a new target, the transition starts from the current
interpolated value. Continuous turns repeatedly revisit the start of the
easing curve. Long durations with ease-in or smoothstep can trail the knob
until it stops. Shorter durations, linear easing, or ease-out respond faster
under continuous movement. A direction reversal keeps the value continuous,
while its speed can change immediately.

The [diagnostic sketch](./midi-easing/README.md) displays six independently
mapped parameters for side-by-side checks.

## Verification

Run `bun test`, `bun run lint`, and `bun run build`. With the app server running,
run `node scripts/midi-smoke.js`. Set `CHROMIUM_PATH` if using a system Chromium and
`HYDRACTRL_URL` if the server is on a different address. The browser test uses
simulated Web MIDI inputs and a real primary output page.

Physical acceptance still requires a UC-33 to learn the actual rotary, lower
button, bank buttons, and faders, check their button modes and full ranges, and
verify USB disconnect/reconnect on the target system. Test the nanoPAD2 scene
buttons and XY pad on a physical unit. With a Windows Spout receiver or a macOS
Syphon receiver attached, confirm that scene changes and parameter moves
appear in the receiver and pending markers stay in the application interface.
