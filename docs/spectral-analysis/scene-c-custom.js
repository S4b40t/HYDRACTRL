// Red: 20–150 Hz. Amber: 150–1500 Hz. Green: 1500–16000 Hz.
a.setBandRanges([
  [20, 150],
  [150, 1500],
  [1500, 16000],
]);
a.setSmooth(0.4);
a.setCutoff(2);
a.setScale(10);
a.show();

const palette = [
  [1, 0.17, 0.1],
  [1, 0.6, 0.1],
  [0.53, 1, 0.13],
];
let view = solid(0, 0, 0);
palette.forEach(([r, g, b], i) => {
  const brightness = () => 0.14 + 0.86 * Math.min(1, a.fft[i]);
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
