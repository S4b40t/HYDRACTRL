import { linkBeatPeriod, wrapBeat } from "../shared/linkClock.js";

/** Offset maps the helper's clock to the caller's monotonic microseconds. */
export function measureLinkClock(sentUs, receivedUs, hostUs) {
  const roundTripUs = receivedUs - sentUs;
  return { roundTripUs, offsetUs: sentUs + roundTripUs / 2 - hostUs };
}

/** Estimate the Link timeline at a time in the caller's monotonic clock. */
export function estimateLinkTiming(sample, offsetUs, nowUs) {
  const ageUs = nowUs - (sample.hostUs + offsetUs);
  const elapsedBeats = ageUs / linkBeatPeriod(sample.bpm);
  return {
    ageUs,
    beat: sample.beat + elapsedBeats,
    phase: wrapBeat(sample.phase + elapsedBeats, sample.quantum),
  };
}
