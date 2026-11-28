// Run in a temporary slot. These four tests need no Setup declarations.
const range = { default: 0, min: 0, max: 1 };
const smootherstep = (t) => t ** 3 * (t * (6 * t - 15) + 10);
const easeOut = (t) => 1 - (1 - t) ** 2;
const lanes = [
  midiParam("Slow attack button", { ...range, takeover: false, attack: 1700, release: 200 }),
  midiParam("Slow release button", { ...range, takeover: false, attack: 200, release: 1700 }),
  midiParam("Asymmetric knob", { ...range, default: 0.2, attack: 300, release: 70, curve: 2 }),
  midiParam("Independent easings", {
    ...range, takeover: false, attack: 700, release: 700,
    attackEase: smootherstep, releaseEase: easeOut,
  }),
];

globalThis.midiArticulationDemo = lanes;
lanes.reduce(
  (canvas, value, lane) => canvas.add(
    shape(4, 0.095, 0.004)
      .color(0.3 + lane * 0.2, 1 - lane * 0.15, 0.85)
      .scrollX(() => 0.44 - 0.88 * value())
      .scrollY((1.5 - lane) / 4),
  ),
  solid(0.03, 0.04, 0.06),
).out();
