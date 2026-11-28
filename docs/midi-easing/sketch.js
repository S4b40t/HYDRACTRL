const range = { default: 0.2, min: 0, max: 1 };
const lanes = [
  midiParam("Linear", { ...range, attack: 100, release: 100 }),
  midiParam("Smoothstep", { ...range, attack: 400, release: 400, attackEase: smoothstep }),
  midiParam("Ease in", { ...range, attack: 400, release: 400, attackEase: easeIn }),
  midiParam("Ease out", { ...range, attack: 100, release: 100, attackEase: easeOut }),
  midiParam("Ease out power 4", { ...range, attack: 400, release: 400, attackEase: (t) => easeOut(t, 4) }),
  midiParam("Elastic", { ...range, attack: 600, release: 600, attackEase: elastic }),
];

globalThis.midiEasingDiagnostic = lanes;
const colors = [
  [1, 1, 1],
  [0.2, 0.8, 1],
  [1, 0.4, 0.3],
  [0.35, 1, 0.5],
  [1, 0.85, 0.2],
  [0.85, 0.5, 1],
];

lanes
  .reduce(
    (canvas, value, lane) =>
      canvas.add(
        shape(4, 0.075, 0.004)
          .scale(1, 0.5, 1.5)
          .color(...colors[lane])
          .scrollX(() => 0.45 - 0.9 * value())
          .scrollY((2.5 - lane) / 6),
      ),
    solid(0.03, 0.04, 0.06),
  )
  .out();
