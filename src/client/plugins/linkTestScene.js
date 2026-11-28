export const LINK_TEST_SCENE = `// HYDRACTRL Link Test Scene
// Red means free-running. Teal means a Link peer is driving the visual.
// The moving square steps through four beats. The first beat flashes gold.
{
  const linkTestRead = () => globalThis.hydractrlLink?.read() ?? { phase: 0, synced: false };
  const linkTestPulse = () => globalThis.hydractrlLink?.pulse(0.3) ?? 0;
  const linkTestBeat = () => Math.floor(linkTestRead().phase) % 4;
  const linkTestDown = () => linkTestBeat() === 0 ? linkTestPulse() : 0;
  solid(0.025, 0.035, 0.05)
    .layer(shape(4, 0.12, 0.015)
      .scale(() => 0.95 + 0.55 * linkTestPulse())
      .scrollX(() => (linkTestBeat() - 1.5) * 0.21)
      .color(() => linkTestRead().synced ? 0.12 + 0.88 * linkTestDown() : 0.85,
             () => linkTestRead().synced ? 0.85 : 0.17,
             () => linkTestRead().synced ? 0.68 - 0.48 * linkTestDown() : 0.16))
    .out(o0);
}`;
