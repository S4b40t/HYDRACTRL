const range = { default: 0.2, min: 0, max: 1 };
const lanes = [
  midiParam("Linear", { ...range, smoothing: 100 }),
  midiParam("Smoothstep", { ...range, smoothing: 400, easing: smoothstep }),
  midiParam("Ease in", { ...range, smoothing: 400, easing: easeIn }),
  midiParam("Ease out", { ...range, smoothing: 100, easing: easeOut }),
  midiParam("Ease out power 4", { ...range, smoothing: 400, easing: (t) => easeOut(t, 4) }),
  midiParam("Elastic", { ...range, smoothing: 600, easing: elastic }),
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
