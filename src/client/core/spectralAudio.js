import { copyBandRanges } from "../../spectralRanges.ts";
import {
  SPECTRAL_FFT_SIZE,
  createBandMeter,
  sameBandRanges,
  updateBandControls,
} from "./spectralBands.js";

/** Add the opt-in API to Hydra's audio object. The input manager owns its source. */
export function installSpectralAudio(audio) {
  if (!audio?.tick) return null;

  const drawLegacy = audio.draw.bind(audio);
  const setLegacyBins = audio.setBins.bind(audio);
  const legacyTitle = audio.canvas.title;
  let legacy = null;
  let ranges = null;
  let meter = null;
  let source = null;
  let analyser = null;

  function disconnect() {
    if (analyser) source.disconnect(analyser);
    analyser = null;
  }

  function setSource(next) {
    if (source === next) return;
    disconnect();
    source = next;
  }

  function clear() {
    if (!ranges) return;
    disconnect();
    // The saved settings include any global control changes made in custom mode.
    Object.assign(audio, legacy);
    audio.bins.fill(0);
    audio.prevBins.fill(0);
    audio.fft.fill(0);
    audio.canvas.title = legacyTitle;
    ranges = meter = legacy = null;
    audio.ctx.clearRect(0, 0, audio.canvas.width, audio.canvas.height);
  }

  audio.setBandRanges = (next) => {
    const copy = copyBandRanges(next);
    // Hydra reuses this context when getUserMedia completes. Creating it
    // lazily here makes synchronous Nyquist validation possible before permission.
    audio.context ??= new AudioContext();
    const { sampleRate } = audio.context;
    const nyquist = sampleRate / 2;
    if (copy.some(([, high]) => high > nyquist)) {
      throw new RangeError(`Frequency ranges cannot exceed Nyquist (${nyquist} Hz)`);
    }
    if (ranges && sameBandRanges(ranges, copy)) return;
    const nextMeter = createBandMeter(copy, sampleRate);
    legacy ??= {
      bins: audio.bins,
      prevBins: audio.prevBins,
      fft: audio.fft,
      settings: audio.settings,
    };
    setLegacyBins(copy.length);
    ranges = copy;
    meter = nextMeter;
    audio.canvas.title = copy.map(([low, high], i) => `${i}: ${low}–${high} Hz`).join("\n");
  };

  audio.getBandRanges = () => ranges?.map(([low, high]) => [low, high]) ?? null;
  audio.clearBandRanges = clear;
  audio.setBins = (count) => {
    // Preserve the current mode if Hydra's Array(count) would throw.
    setLegacyBins(count);
    if (!ranges) return;
    disconnect();
    audio.canvas.title = legacyTitle;
    ranges = meter = legacy = null;
    audio.ctx.clearRect(0, 0, audio.canvas.width, audio.canvas.height);
  };

  for (const [method, key] of [
    ["setSmooth", "smooth"],
    ["setCutoff", "cutoff"],
    ["setScale", "scale"],
  ]) {
    const set = audio[method].bind(audio);
    audio[method] = (value) => {
      set(value);
      for (const settings of legacy?.settings ?? []) settings[key] = value;
    };
  }

  audio.draw = () => {
    if (!ranges) {
      drawLegacy();
      return;
    }
    const { width, height } = audio.canvas;
    const spacing = width / ranges.length;
    audio.ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < ranges.length; i += 1) {
      const barHeight = height * audio.fft[i];
      audio.ctx.fillRect(i * spacing, height - barHeight, Math.max(0.5, spacing - 1), barHeight);
    }
  };

  // Hydra invokes this after its original loudness and beat processing, so
  // range changes from an onBeat handler take effect in the current frame.
  audio._updateCustomBins = () => {
    if (!ranges) return false;

    let levels = null;
    if (source && audio.context.state === "running") {
      if (!analyser) {
        analyser = audio.context.createAnalyser();
        analyser.fftSize = SPECTRAL_FFT_SIZE;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
      }
      analyser.getFloatFrequencyData(meter.decibels);
      levels = meter.measure();
    }
    updateBandControls(audio, levels);
    if (audio.isDrawing) audio.draw();
    return true;
  };

  return {
    setSource,
    dispose() {
      clear();
      setSource(null);
    },
  };
}
