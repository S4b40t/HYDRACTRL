export const SPECTRAL_FFT_SIZE = 4096;

// Web Audio's periodic Blackman window has mean square 0.3046. Its FFT is
// scaled by 1/N, so double the power of positive, non-DC coefficients.
const POWER_TO_MEAN_SQUARE = 2 / 0.3046;
const RMS_TO_CONTROL_UNITS = 100;

export function sameBandRanges(left, right) {
  return (
    left.length === right.length &&
    left.every(([low, high], index) => low === right[index][0] && high === right[index][1])
  );
}

export function createBandMeter(ranges, sampleRate, fftSize = SPECTRAL_FFT_SIZE) {
  const step = sampleRate / fftSize;
  const lastBin = fftSize / 2 - 1;
  const bands = ranges.map(([low, high]) => {
    const first = Math.min(lastBin, Math.floor(low / step + 0.5));
    const last = Math.max(first, Math.min(lastBin, Math.ceil(high / step + 0.5) - 1));
    function fraction(bin) {
      const start = Math.max(0, (bin - 0.5) * step);
      // Web Audio omits the Nyquist coefficient. Extend the final available
      // coefficient's coverage to Nyquist for ranges at the upper edge.
      const end = bin === lastBin ? sampleRate / 2 : (bin + 0.5) * step;
      return Math.max(0, Math.min(high, end) - Math.max(low, start)) / (end - start);
    }
    return { first, last, firstWeight: fraction(first), lastWeight: fraction(last) };
  });
  const first = Math.min(...bands.map((band) => band.first));
  const last = Math.max(...bands.map((band) => band.last));
  const powers = new Float64Array(fftSize / 2);
  const sums = new Float64Array(fftSize / 2 + 1);

  return {
    decibels: new Float32Array(fftSize / 2),
    levels: new Float64Array(bands.length),
    measure() {
      for (let i = first; i <= last; i += 1) {
        const db = this.decibels[i];
        const power = Number.isFinite(db) ? 10 ** (Math.min(0, db) / 10) : 0;
        powers[i] = i === 0 ? power / 2 : power;
        sums[i + 1] = sums[i] + powers[i];
      }
      for (let i = 0; i < bands.length; i += 1) {
        const { first, last, firstWeight, lastWeight } = bands[i];
        let power = powers[first] * firstWeight;
        if (last > first) {
          power += sums[last] - sums[first + 1] + powers[last] * lastWeight;
        }
        this.levels[i] =
          Math.sqrt(Math.max(0, power) * POWER_TO_MEAN_SQUARE) * RMS_TO_CONTROL_UNITS;
      }
      return this.levels;
    },
  };
}

export function updateBandControls(audio, levels) {
  for (let i = 0; i < audio.bins.length; i += 1) {
    const { smooth, cutoff, scale } = audio.settings[i];
    const retention = Number.isFinite(smooth) ? Math.max(0, Math.min(0.999, smooth)) : 0;
    const previous = audio.bins[i];
    const level = levels?.[i] ?? 0;
    const smoothed = previous * retention + level * (1 - retention);
    audio.prevBins[i] = previous;
    audio.bins[i] = smoothed > 1e-8 ? smoothed : 0;
    const floor = Number.isFinite(cutoff) ? Math.max(0, cutoff) : 0;
    const span = Number.isFinite(scale) && scale > 0 ? scale : 10;
    audio.fft[i] = Math.max(0, Math.min(1, (audio.bins[i] - floor) / span));
  }
}
