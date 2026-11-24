const US_PER_MINUTE = 60_000_000;

/** Offset maps the helper's clock to the caller's monotonic microseconds. */
export function measureLinkClock(sentUs, receivedUs, hostUs) {
  const roundTripUs = receivedUs - sentUs;
  return { roundTripUs, offsetUs: sentUs + roundTripUs / 2 - hostUs };
}

/** Estimate the Link timeline at a time in the caller's monotonic clock. */
export function estimateLinkTiming(sample, offsetUs, nowUs) {
  const ageUs = nowUs - (sample.hostUs + offsetUs);
  const elapsedBeats = ageUs / Math.round(US_PER_MINUTE / sample.bpm);
  const phase = (sample.phase + elapsedBeats) % sample.quantum;
  return {
    ageUs,
    beat: sample.beat + elapsedBeats,
    phase: phase < 0 ? (phase + sample.quantum) % sample.quantum : phase || 0,
  };
}
