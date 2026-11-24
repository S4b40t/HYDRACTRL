import { describe, expect, test } from "bun:test";
import { estimateLinkTiming, measureLinkClock } from "./linkTiming.js";

const sample = { hostUs: 10_000_000, bpm: 120, beat: 11.75, phase: 3.75, quantum: 4 };
const offsetUs = -9_000_000;

describe("Link timing", () => {
  test("maps the helper timestamp into the caller's send/receive interval", () => {
    expect(measureLinkClock(999_900, 1_000_100, sample.hostUs)).toEqual({
      roundTripUs: 200,
      offsetUs,
    });
  });

  test("uses elapsed time and wraps the configured quantum", () => {
    expect(estimateLinkTiming(sample, offsetUs, 1_125_000)).toEqual({
      ageUs: 125_000,
      beat: 12,
      phase: 0,
    });
    const inThree = { ...sample, beat: 2.75, phase: 2.75, quantum: 3 };
    expect(estimateLinkTiming(inThree, offsetUs, 1_250_000).phase).toBe(0.25);
  });

  test("supports negative beats and evaluation before the anchor", () => {
    const beforeOrigin = { ...sample, beat: 0, phase: 0 };
    expect(estimateLinkTiming(beforeOrigin, offsetUs, 875_000)).toEqual({
      ageUs: -125_000,
      beat: -0.25,
      phase: 3.75,
    });
  });

  test("applies the new tempo to the new anchor even after a sampling gap", () => {
    const changed = { ...sample, hostUs: 10_125_000, beat: 12, phase: 0, bpm: 150 };
    expect(estimateLinkTiming(changed, offsetUs, 2_025_000)).toEqual({
      ageUs: 900_000,
      beat: 14.25,
      phase: 2.25,
    });
  });
});
