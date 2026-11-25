import { afterEach, describe, expect, test } from "bun:test";
import { MAX_SPECTRAL_BANDS } from "../../spectralRanges.ts";
import { installSpectralAudio } from "./spectralAudio.js";
import { SPECTRAL_FFT_SIZE, createBandMeter } from "./spectralBands.js";

const SAMPLE_RATE = 48000;
const OVERLAPS = [
  [20, 80],
  [50, 150],
  [120, 250],
];

function createAudio(sampleRate = SAMPLE_RATE) {
  const events = [];
  const context = {
    state: "running",
    sampleRate,
    createAnalyser() {
      events.push("created");
      return {
        fftSize: 0,
        smoothingTimeConstant: 1,
        getFloatFrequencyData(bins) {
          bins.fill(Number.NEGATIVE_INFINITY);
          if (context.state !== "running") throw new Error("Inactive context");
          bins[6] = -30;
        },
      };
    },
  };
  const source = {
    connect(node) {
      events.push("connected");
      expect(node.fftSize).toBe(SPECTRAL_FFT_SIZE);
      expect(node.smoothingTimeConstant).toBe(0);
    },
    disconnect() {
      events.push("disconnected");
    },
  };
  const audio = {
    bins: [],
    prevBins: [],
    fft: [],
    settings: [],
    smooth: 0.4,
    cutoff: 2,
    scale: 10,
    context,
    canvas: { width: 100, height: 80, title: "" },
    ctx: {
      clearRect() {},
      fillRect() {
        events.push("bar");
      },
    },
    setBins(n) {
      this.fft = Array(n).fill(0);
      this.bins = Array(n).fill(0);
      this.prevBins = Array(n).fill(0);
      this.settings = this.fft.map(() => ({
        smooth: this.smooth,
        cutoff: this.cutoff,
        scale: this.scale,
      }));
    },
    tick() {
      const features = this.meyda?.get();
      if (!features) {
        this._updateCustomBins?.();
        return;
      }
      this.vol = features.loudness.total;
      this.detectBeat(this.vol);
      if (this._updateCustomBins?.()) return;
      this.fft = [8, 9, 10];
      if (this.isDrawing) this.draw();
    },
    draw() {
      events.push("legacy drawn");
    },
    detectBeat(level) {
      events.push(level);
      this.onBeat();
    },
    onBeat() {},
    meyda: { get: () => ({ loudness: { total: 42 } }) },
  };
  for (const key of ["smooth", "cutoff", "scale"]) {
    const name = `set${key[0].toUpperCase()}${key.slice(1)}`;
    audio[name] = (value) => {
      audio[key] = value;
      for (const settings of audio.settings) settings[key] = value;
    };
  }
  audio.setBins(3);
  return { audio, context, source, events };
}

const originalAudioContext = globalThis.AudioContext;
afterEach(() => {
  if (originalAudioContext === undefined) Reflect.deleteProperty(globalThis, "AudioContext");
  else globalThis.AudioContext = originalAudioContext;
});

describe("band power meter", () => {
  test("selects frequencies in sketch order and measures duplicate and overlapping bands independently", () => {
    const meter = createBandMeter(
      [OVERLAPS[2], ...OVERLAPS, OVERLAPS[0], [500, 1200]],
      SAMPLE_RATE,
    );
    meter.decibels.fill(Number.NEGATIVE_INFINITY);
    meter.decibels[6] = -30; // 70.3125 Hz
    const levels = meter.measure();
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBeGreaterThan(5);
    expect(levels[2]).toBeCloseTo(levels[1]);
    expect(levels[3]).toBe(0);
    expect(levels[4]).toBe(levels[1]);
    expect(levels[5]).toBe(0);

    meter.decibels[64] = -26; // 750 Hz
    expect(meter.measure()[5]).toBeGreaterThan(10);
    expect(levels[1]).toBeCloseTo(levels[4]);
    meter.decibels[6] = Number.NEGATIVE_INFINITY;
    expect(meter.measure()[1]).toBe(0);
  });

  test("weights boundary coefficients in power and uses the given sample rate", () => {
    const bands = [
      [50, 85],
      [70.3125, 85],
      [500, 20000],
    ];
    const meter = createBandMeter(bands, 48000);
    meter.decibels.fill(Number.NEGATIVE_INFINITY);
    meter.decibels[6] = -30;
    const [full, half, wide] = meter.measure();
    expect(half).toBeCloseTo(full * Math.SQRT1_2);
    expect(wide).toBe(0);

    const higherRate = createBandMeter(bands, 96000);
    higherRate.decibels.set(meter.decibels);
    expect(higherRate.measure()[0]).toBe(0);
    higherRate.decibels[3] = -30;
    expect(higherRate.measure()[0]).toBeCloseTo(full);
  });

  test("handles fractional single-coefficient ranges, DC, Nyquist edge and nonfinite data", () => {
    const meter = createBandMeter(
      [
        [0, 1],
        [1, 2],
        [23999, 24000],
        [200, 201],
      ],
      SAMPLE_RATE,
    );
    meter.decibels.fill(Number.NEGATIVE_INFINITY);
    meter.decibels[0] = -34;
    meter.decibels[meter.decibels.length - 1] = -36;
    meter.decibels[17] = Number.NaN;
    const levels = meter.measure();
    expect(levels[0]).toBeGreaterThan(0);
    expect(levels[1]).toBeCloseTo(levels[0]);
    expect(levels[2]).toBeGreaterThan(0);
    expect(levels[3]).toBe(0);
  });
});

describe("Hydra spectral adapter", () => {
  test("validates atomically and copies both the request and getter", () => {
    const { audio } = createAudio(44100);
    installSpectralAudio(audio);
    expect(audio.getBandRanges()).toBeNull();
    const input = [
      [0, 1],
      [22049.5, 22050],
    ];
    audio.setBandRanges(input);
    input[0][0] = 0.5;
    audio.getBandRanges()[1][1] = 0;
    const bad = [
      undefined,
      null,
      {},
      [],
      [null],
      [[1]],
      [[1, 2, 3]],
      [["0", 1]],
      [[0, Number.POSITIVE_INFINITY]],
      [[0, Number.NaN]],
      [[-1, 2]],
      [[2, 1]],
      [[1, 1]],
      [[0, 22050.0001]],
      [Array(2)],
      Array(1),
      Array.from({ length: MAX_SPECTRAL_BANDS + 1 }, () => [0, 1]),
    ];
    const fft = audio.fft;
    for (const ranges of bad) {
      expect(() => audio.setBandRanges(ranges)).toThrow();
      expect(audio.getBandRanges()).toEqual([
        [0, 1],
        [22049.5, 22050],
      ]);
      expect(audio.fft).toBe(fft);
    }
    audio.setBandRanges(Array.from({ length: MAX_SPECTRAL_BANDS }, () => [0, 1]));
    expect(audio.fft).toHaveLength(MAX_SPECTRAL_BANDS);
  });

  test("validates against the eventual capture context before permission completes", () => {
    const { audio, context } = createAudio(32000);
    audio.context = undefined;
    audio.meyda = null;
    let contexts = 0;
    globalThis.AudioContext = class {
      constructor() {
        contexts += 1;
        Object.assign(this, context);
      }
    };
    installSpectralAudio(audio);
    expect(() => audio.setBandRanges([])).toThrow();
    expect(contexts).toBe(0);
    expect(() => audio.setBandRanges([[0, 16001]])).toThrow();
    expect(audio.getBandRanges()).toBeNull();
    audio.setBandRanges([[0, 16000]]);
    audio.tick();
    expect(audio.fft).toEqual([0]);
    expect(contexts).toBe(1);
  });

  test("preserves the legacy analyser and beat semantics, then restores legacy controls", () => {
    const { audio, source, events } = createAudio();
    const spectral = installSpectralAudio(audio);
    spectral.setSource(source);
    audio.isDrawing = true;
    audio.setBins(3);
    audio.setSmooth(0.85);
    audio.settings[1].scale = 15;
    audio.tick();
    expect(audio.fft).toEqual([8, 9, 10]); // Legacy values can exceed one.
    expect(events).toEqual([42, "legacy drawn"]);

    let beats = 0;
    audio.onBeat = () => {
      beats += 1;
    };
    audio.setBandRanges([
      [40, 100],
      [50, 100],
    ]);
    expect(audio.settings[0].smooth).toBe(0.85);
    audio.setCutoff(0);
    audio.tick();
    expect(audio.vol).toBe(42);
    expect(beats).toBe(1);
    expect(audio.fft[0]).toBeGreaterThan(0);
    expect(events.filter((event) => event === "bar")).toHaveLength(2);
    expect(audio.canvas.title).toContain("40–100 Hz");
    const active = audio.fft;
    audio.setBandRanges([
      [40, 100],
      [50, 100],
    ]);
    expect(audio.fft).toBe(active);

    audio.clearBandRanges();
    expect(audio.getBandRanges()).toBeNull();
    expect(audio.fft).toEqual([0, 0, 0]);
    expect(audio.settings[1]).toEqual({ cutoff: 0, smooth: 0.85, scale: 15 });
    expect(audio.canvas.title).toBe("");
    audio.setBandRanges([[0, 22050]]);
    audio.setBins(3);
    expect(audio.getBandRanges()).toBeNull();
    expect(audio.settings[1].scale).toBe(10);
    audio.tick();
    expect(audio.fft).toEqual([8, 9, 10]);
    expect(beats).toBe(2);
  });

  test("reuses the node for reconfiguration, disconnects on input loss and reattaches once", () => {
    const { audio, context, source, events } = createAudio();
    const spectral = installSpectralAudio(audio);
    spectral.setSource(source);
    audio.setBandRanges(OVERLAPS);
    audio.setSmooth(0.5);
    audio.setCutoff(0);
    audio.tick();
    const first = audio.fft[0];
    audio.tick();
    expect(audio.fft[0]).toBeGreaterThan(first);
    context.state = "suspended";
    audio.tick();
    expect(audio.fft[0]).toBeCloseTo(first * 0.75);
    context.state = "running";
    audio.setBandRanges([[40, 200]]);
    audio.tick();
    expect(events.filter((event) => event === "created")).toHaveLength(1);
    spectral.setSource(null);
    const beforeLoss = audio.fft[0];
    audio.tick();
    expect(audio.fft[0]).toBeCloseTo(beforeLoss * 0.5);
    for (let frame = 0; frame < 100; frame += 1) audio.tick();
    expect(audio.fft).toEqual([0]);
    spectral.setSource({ ...source });
    audio.tick();
    expect(audio.fft[0]).toBeGreaterThan(0);
    spectral.dispose();
    spectral.dispose();
    expect(events.filter((event) => event === "created")).toHaveLength(2);
    expect(events.filter((event) => event === "disconnected")).toHaveLength(2);
  });

  test("uses the mode chosen by an onBeat handler during the same frame", () => {
    const { audio, source } = createAudio();
    installSpectralAudio(audio).setSource(source);
    audio.onBeat = () => {
      audio.setBandRanges(Array.from({ length: MAX_SPECTRAL_BANDS }, () => [20, 80]));
    };
    audio.tick();
    expect(audio.fft).toHaveLength(MAX_SPECTRAL_BANDS);
    expect(audio.fft.every((level) => Number.isFinite(level) && level >= 0 && level <= 1)).toBe(
      true,
    );
    audio.onBeat = () => audio.setBins(3);
    audio.tick();
    expect(audio.getBandRanges()).toBeNull();
    expect(audio.fft).toEqual([8, 9, 10]);
  });
});
