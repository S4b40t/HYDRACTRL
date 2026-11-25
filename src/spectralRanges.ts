export const MAX_SPECTRAL_BANDS = 64;
export type BandRange = [number, number];

/** Validate and copy band ranges at the sketch API and WebSocket boundaries. */
export function copyBandRanges(ranges: unknown): BandRange[] {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > MAX_SPECTRAL_BANDS) {
    throw new RangeError(`Expected 1 to ${MAX_SPECTRAL_BANDS} frequency ranges`);
  }

  const copy: BandRange[] = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) {
      throw new TypeError("Expected each frequency range to be a pair of finite numbers");
    }
    const [low, high] = range;
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      throw new TypeError("Expected each frequency range to be a pair of finite numbers");
    }
    if (low < 0 || high <= low) {
      throw new RangeError("Expected 0 <= low < high for each frequency range");
    }
    copy.push([low, high]);
  }
  return copy;
}
