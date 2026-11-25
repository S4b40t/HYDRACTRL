// Red: 20–80 Hz. Amber: 50–150 Hz. Green: 120–250 Hz.
a.setBandRanges([
  [20, 80],
  [50, 150],
  [120, 250],
]);
a.setSmooth(0.25);
a.setCutoff(0.3);
a.setScale(7);
a.show();

const palette = [
  [1, 0.17, 0.1],
  [1, 0.6, 0.1],
  [0.53, 1, 0.13],
];
let view = solid(0, 0, 0);
palette.forEach(([r, g, b], i) => {
  const brightness = () => 0.14 + 0.86 * a.fft[i];
  const column = shape(4, 0.48, 0.018)
    .scale(1, 1 / 3, 0.9)
    .scrollX(0.5 - (i + 0.5) / 3);
  view = view.add(
    column.color(
      () => r * brightness(),
      () => g * brightness(),
      () => b * brightness(),
    ),
  );
});
view.out();
