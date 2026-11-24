export const LINK_STALE_US = 600_000;
export const LINK_SLEW_US = 500_000;

export function wrapBeat(beat, quantum) {
  const phase = beat % quantum;
  return phase < 0 ? (phase + quantum) % quantum : phase || 0;
}

export function linkBeatPeriod(bpm) {
  return Math.round(60_000_000 / bpm);
}

/** Evaluate the same published anchor in main and in every renderer. */
export function projectLink(anchor, nowUs) {
  const ageUs = Math.max(0, nowUs - anchor.atUs);
  const elapsed =
    ageUs / linkBeatPeriod(anchor.bpm) + anchor.slew * Math.min(1, ageUs / LINK_SLEW_US);
  const grid = anchor.grid + elapsed;
  const phase = wrapBeat(grid, anchor.quantum);
  return { beat: anchor.beat + elapsed, grid, phase, normalizedPhase: phase / anchor.quantum };
}

export function createLinkTimeline(atUs = 0, quantum = 4) {
  return { atUs, bpm: 120, beat: 0, grid: 0, quantum, epoch: 0, slew: 0 };
}

export function anchorLink(previous, nowUs, { bpm, quantum, phase, reset = false }) {
  const { beat, grid } = projectLink(previous, nowUs);
  const basis = { atUs: nowUs, bpm, beat, grid, quantum, epoch: previous.epoch, slew: 0 };
  if (phase === undefined && previous.quantum === quantum && !reset) return basis;
  const target = phase ?? wrapBeat(grid, quantum);
  const error = wrapBeat(target - grid + quantum / 2, quantum) - quantum / 2;
  // Small adjustments cannot reverse the beat, even at the minimum Link BPM.
  if (!reset && previous.quantum === quantum && Math.abs(error) <= 0.125) {
    return { ...basis, slew: error };
  }
  return { ...basis, grid: grid + error, epoch: previous.epoch + 1 };
}
