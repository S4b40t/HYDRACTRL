// Usage: bun docs/spectral-analysis/generate-audio.mjs [output.wav]
import { writeFileSync } from "node:fs";

const sampleRate = 48000;
const sections = [
  { seconds: 2 },
  { seconds: 1.5, tones: [36] },
  { seconds: 2, tones: [70] },
  { seconds: 2, tones: [135] },
  { seconds: 1.5, tones: [300] },
  { seconds: 1.5, tones: [1000] },
  { seconds: 1.5, tones: [3200] },
  { seconds: 1.5, tones: [7500] },
  { seconds: 1.5, tones: [18000], gain: 0.06 },
  { seconds: 2, tones: [70, 1000, 7500] },
  { seconds: 5, sweep: [30, 12000] },
  { seconds: 4, tones: [1000], ramp: [0.012, 0.16] },
  { seconds: 2 },
];

const samples = sections.reduce((total, { seconds }) => total + seconds * sampleRate, 0);
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(1, 22); // Mono
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);

let offset = 44;
for (const { seconds, tones, sweep, ramp, gain = 0.15 } of sections) {
  const sweepRate = sweep ? Math.log(sweep[1] / sweep[0]) / seconds : 0;
  for (let i = 0; i < seconds * sampleRate; i += 1) {
    const time = i / sampleRate;
    const fade = Math.min(1, time / 0.04, (seconds - time) / 0.04);
    let sample = 0;
    if (sweep) {
      const phase = (sweep[0] * Math.expm1(sweepRate * time)) / sweepRate;
      sample = gain * Math.sin(2 * Math.PI * phase);
    } else if (tones) {
      const amplitude = ramp ? ramp[0] + (ramp[1] - ramp[0]) * (time / seconds) : gain;
      for (const hz of tones)
        sample += (amplitude / Math.sqrt(tones.length)) * Math.sin(2 * Math.PI * hz * time);
    }
    wav.writeInt16LE(Math.round(sample * fade * 32767), offset);
    offset += 2;
  }
}
const output = process.argv[2] || "spectral-diagnostics.wav";
writeFileSync(output, wav);
console.log(`Wrote ${samples / sampleRate}s of mono PCM to ${output}`);
