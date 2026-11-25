// Left to right: 20–60, 50–150, 120–500, 400–2000, 1500–5000, 4000–16000 Hz.
a.setBandRanges([
  [20, 60],
  [50, 150],
  [120, 500],
  [400, 2000],
  [1500, 5000],
  [4000, 16000],
]);
a.setSmooth(0.25);
a.setCutoff(0.3);
a.setScale(7);
a.show();

const palette = [
  [1, 0.17, 0.1],
  [1, 0.6, 0.1],
  [0.53, 1, 0.13],
  [0.12, 0.96, 0.85],
  [0.23, 0.46, 1],
  [0.9, 0.18, 1],
];
let view = solid(0, 0, 0);
palette.forEach(([r, g, b], i) => {
  const brightness = () => 0.14 + 0.86 * a.fft[i];
  const column = shape(4, 0.48, 0.018)
    .scale(1, 1 / 6, 0.9)
    .scrollX(0.5 - (i + 0.5) / 6);
  view = view.add(
    column.color(
      () => r * brightness(),
      () => g * brightness(),
      () => b * brightness(),
    ),
  );
});
view.out();
