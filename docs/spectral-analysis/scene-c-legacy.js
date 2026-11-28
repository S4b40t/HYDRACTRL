// Red, amber and green read the three legacy bins.
a.setBins(3);
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
