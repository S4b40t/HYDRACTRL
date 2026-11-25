/** With the built HYDRACTRL server running: bun scripts/spectral-smoke.mjs [url] [--benchmark] */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createBandMeter } from "../src/client/core/spectralBands.js";

const url = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "http://127.0.0.1:3000";
const browser = await chromium.launch({
  executablePath: process.env.SPECTRAL_CHROMIUM || undefined,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  const NativeContext = window.AudioContext;
  const generator = new NativeContext();
  const tracks = [];
  const contexts = [];
  const counts = { requests: 0, analysers: 0 };
  const devices = [
    { kind: "audioinput", deviceId: "default", label: "Default" },
    { kind: "audioinput", deviceId: "low", label: "Low test tone" },
    { kind: "audioinput", deviceId: "high", label: "High test tone" },
  ];
  const waiters = [];
  let blocked = new URLSearchParams(location.search).has("delayCapture");
  let unavailable = false;
  window.AudioContext = class extends NativeContext {
    constructor(...args) {
      super(...args);
      contexts.push(this);
    }
    createAnalyser() {
      counts.analysers += 1;
      return super.createAnalyser();
    }
  };
  navigator.mediaDevices.enumerateDevices = async () =>
    unavailable ? devices.filter((device) => device.deviceId !== "high") : devices;
  navigator.mediaDevices.getUserMedia = async ({ audio }) => {
    counts.requests += 1;
    if (blocked) await new Promise((resolve) => waiters.push(resolve));
    const high = audio.deviceId?.exact === "high";
    if (high && unavailable) throw new DOMException("Input absent", "NotFoundError");
    const output = generator.createMediaStreamDestination();
    const source = generator.createOscillator();
    const gain = generator.createGain();
    gain.gain.value = 0.08;
    source.frequency.value = high ? 1000 : 70;
    source.connect(gain).connect(output);
    source.start();
    await generator.resume();
    tracks.push({ track: output.stream.getAudioTracks()[0], source, gain });
    return output.stream;
  };
  window.spectralFixture = {
    tracks,
    contexts,
    counts,
    unblock() {
      blocked = false;
      for (const resolve of waiters.splice(0)) resolve();
    },
    change({ gain, frequency }) {
      const current = tracks.at(-1);
      if (gain !== undefined) current.gain.gain.value = gain;
      if (frequency !== undefined) current.source.frequency.value = frequency;
    },
    unplug() {
      unavailable = true;
      const { track } = tracks.at(-1);
      track.stop();
      track.dispatchEvent(new Event("ended"));
    },
    replug() {
      unavailable = false;
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    },
  };
});

const ranges = [
  [20, 80],
  [50, 150],
  [120, 250],
  [400, 2000],
];
const inheritedScene =
  'if (a.getBandRanges()?.length !== 4) throw Error("Missing bands"); solid(0.3).out()';
const highInput = { deviceId: "high", label: "High test tone" };

async function runEditor(page, code) {
  await page.evaluate((next) => {
    const editor = window._editorProxy;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: next } });
    document.getElementById("run-btn").click();
  }, code);
}

async function waitForTone(page, index) {
  await page.waitForFunction((band) => {
    const fft = window.a?.fft;
    return fft?.length === 4 && fft[band] > 0.42 && fft[band === 3 ? 0 : 3] < 0.08;
  }, index);
}

async function checkResolution(page) {
  const rows = [];
  for (const fftSize of [1024, 2048, 4096]) {
    const db = await page.evaluate(async (size) => {
      const offline = new OfflineAudioContext(1, 8192, 48000);
      const tone = offline.createOscillator();
      tone.frequency.value = 70;
      const gain = offline.createGain();
      gain.gain.value = 0.1;
      const analyser = offline.createAnalyser();
      analyser.fftSize = size;
      analyser.smoothingTimeConstant = 0;
      tone.connect(gain).connect(analyser).connect(offline.destination);
      tone.start();
      const spectra = offline.suspend(6144 / offline.sampleRate).then(() => {
        const db = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(db);
        offline.resume();
        return Array.from(db);
      });
      await offline.startRendering();
      return spectra;
    }, fftSize);
    const meter = createBandMeter(
      [
        [20, 60],
        [50, 150],
        [20, 80],
        [50, 150],
        [20, 20000],
      ],
      48000,
      fftSize,
    );
    meter.decibels.set(db);
    const [low, center, overlapLow, overlapHigh, wide] = meter.measure();
    rows.push({
      fftSize,
      stepHz: +(48000 / fftSize).toFixed(2),
      windowMs: +((1000 * fftSize) / 48000).toFixed(2),
      leakageRatio: +(low / center).toFixed(3),
      overlapLow: +overlapLow.toFixed(2),
      overlapHigh: +overlapHigh.toFixed(2),
      wide: +wide.toFixed(2),
    });
  }
  assert.ok(
    rows[2].leakageRatio < rows[1].leakageRatio && rows[1].leakageRatio < rows[0].leakageRatio,
  );
  assert.ok(rows[2].overlapLow > 5 && rows[2].overlapHigh > 6);
  assert.ok(Math.abs(rows[2].wide - 100 * 0.1 * Math.SQRT1_2) < 0.1);
  console.table(rows);
}

async function benchmark(page) {
  const measurements = await page.evaluate(async () => {
    const audio = window.a;
    const six = [
      [20, 60],
      [50, 150],
      [120, 500],
      [400, 2000],
      [1500, 5000],
      [4000, 16000],
    ];
    const larger = Array.from({ length: 24 }, (_, i) => [25 * 1.27 ** i, 60 * 1.27 ** i]);
    const scenarios = [
      ["legacy-3", null],
      [
        "custom-3",
        [
          [20, 150],
          [150, 1500],
          [1500, 16000],
        ],
      ],
      ["custom-6", six],
      ["custom-24", larger],
    ];
    const rows = [];
    const tick = audio.tick;
    for (const [mode, bands] of scenarios) {
      if (bands) audio.setBandRanges(bands);
      else audio.setBins(3);
      audio.hide();
      let last;
      const ticks = [];
      const frames = [];
      let timeout;
      try {
        await new Promise((done, fail) => {
          timeout = setTimeout(() => fail(new Error(`Timed out measuring ${mode}`)), 45000);
          audio.tick = () => {
            const start = performance.now();
            try {
              tick.call(audio);
            } catch (error) {
              fail(error);
              return;
            }
            if (last !== undefined && frames.length < 160) {
              ticks.push(performance.now() - start);
              frames.push(start - last);
            }
            last = start;
            if (frames.length === 160) done();
          };
        });
      } finally {
        clearTimeout(timeout);
        audio.tick = tick;
      }
      // Exclude the first 40 frames after changing modes.
      const samples = ticks.slice(40).sort((a, b) => a - b);
      const elapsed = frames.slice(40).reduce((sum, dt) => sum + dt, 0);
      rows.push({
        mode,
        meanAudioMs: +(samples.reduce((sum, dt) => sum + dt, 0) / samples.length).toFixed(3),
        p95AudioMs: +samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3),
        fps: +((1000 * samples.length) / elapsed).toFixed(1),
      });
    }
    return rows;
  });
  console.table(measurements);
}

try {
  console.log(`Chromium ${browser.version()}`);
  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.error("Editor page:", error.message));
  await editor.goto(url);
  await editor.waitForFunction(() =>
    window.hydractrl?.plugins.getApi("output-sync")?.isConnected(),
  );
  await runEditor(
    editor,
    `a.setBins(3); a.setSmooth(0); a.setCutoff(0); a.setBandRanges(${JSON.stringify(ranges)}); solid(0.3).out()`,
  );
  await waitForTone(editor, 0);
  const low = await editor.evaluate(() => [...a.fft]);
  assert.ok(low[1] > 0.48 && low[2] < 0.08, `overlap: ${low}`);
  await runEditor(editor, inheritedScene);

  let output = await context.newPage();
  output.on("pageerror", (error) => console.error("Output page:", error.message));
  await output.goto(new URL("/output?primary&delayCapture", url).href);
  await output.waitForFunction(
    (scene) => window.hydractrlOutput?.lastSketch()?.main === scene,
    inheritedScene,
  );
  assert.deepEqual(await output.evaluate(() => [...a.fft]), [0, 0, 0, 0]);
  assert.equal(await output.evaluate(() => spectralFixture.contexts.length), 1);
  await output.evaluate(() => {
    spectralFixture.unblock();
    a.setSmooth(0);
    a.setCutoff(0);
  });
  await waitForTone(output, 0);
  assert.deepEqual(await output.evaluate(() => spectralFixture.counts), {
    requests: 1,
    analysers: 1,
  });
  assert.equal(await output.evaluate(() => spectralFixture.contexts.length), 1);

  const primaryReply = await editor.evaluate(
    (main) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(new URL("/ws/output", location.href).href);
        socket.onerror = reject;
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", role: "controller" }));
          socket.send(JSON.stringify({ type: "run", id: "spectral-smoke", setup: "", main }));
        };
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== "spectral-smoke") return;
          socket.close();
          resolve(message);
        };
      }),
    inheritedScene,
  );
  assert.equal(primaryReply.success, true);
  assert.deepEqual(primaryReply.bandRanges, ranges);

  // The editor's audio selection is relayed independently of the sketch.
  await editor.evaluate(
    (input) => window.hydractrl.plugins.getApi("audio-input").choose(input),
    highInput,
  );
  await waitForTone(editor, 3);
  await waitForTone(output, 3);
  await output.evaluate(() => spectralFixture.unplug());
  await waitForTone(output, 0);
  await output.evaluate(() => spectralFixture.replug());
  await waitForTone(output, 3);
  assert.equal(await output.evaluate(() => spectralFixture.contexts.length), 1);
  assert.equal(
    await output.evaluate(
      () => spectralFixture.tracks.filter(({ track }) => track.readyState === "live").length,
    ),
    1,
  );

  await output.evaluate(() => spectralFixture.change({ gain: 0.04 }));
  await output.waitForFunction(() => a.fft[3] > 0.24 && a.fft[3] < 0.32);
  await output.evaluate(() => spectralFixture.change({ frequency: 3200 }));
  await output.waitForFunction(() => a.fft.every((level) => level < 0.025));
  await output.evaluate(() => spectralFixture.change({ frequency: 1000, gain: 0.8 }));
  await output.waitForFunction(() => a.fft[3] === 1);
  await output.evaluate(() => spectralFixture.change({ gain: 0 }));
  await output.waitForFunction(() => a.fft.every((level) => level === 0));
  await checkResolution(output);

  // Output reloads after a previous custom run plus a scene with no range setter.
  await output.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await output.waitForFunction(() => a.context.state === "closed");
  assert.deepEqual(
    await output.evaluate(() => spectralFixture.tracks.map(({ track }) => track.readyState)),
    ["ended", "ended", "ended", "ended"],
  );
  await output.close();
  output = await context.newPage();
  await output.goto(new URL("/output?primary", url).href);
  await output.waitForFunction(
    (scene) => window.hydractrlOutput?.lastSketch()?.main === scene,
    inheritedScene,
  );
  assert.deepEqual(await output.evaluate(() => a.getBandRanges()), ranges);
  await output.waitForFunction(
    () => window.hydractrlOutput.audioInput().device?.deviceId === "high",
  );

  for (const file of [
    "scene-a-frequency-separation",
    "scene-b-overlapping-bands",
    "scene-c-custom",
    "scene-c-legacy",
  ]) {
    const scene = (
      await readFile(new URL(`../docs/spectral-analysis/${file}.js`, import.meta.url), "utf8")
    ).trim();
    await runEditor(editor, scene);
    await output.waitForFunction(
      (code) => window.hydractrlOutput?.lastSketch()?.main === code,
      scene,
    );
  }
  assert.equal(await output.evaluate(() => a.fft.length), 3);
  assert.equal(await output.evaluate(() => a.getBandRanges()), null);
  console.log(
    "PASS editor/output replay, input switch, loss/recovery, levels, disposal and diagnostic scenes",
  );

  if (process.argv.includes("--benchmark")) {
    await editor.close();
    const result = await output.evaluate(() =>
      window.hydractrlOutput.run({ main: "solid(0.2, 0.2, 0.2, 0.5).out()" }),
    );
    assert.equal(result.success, true);
    await benchmark(output);
  }
} finally {
  await browser.close();
}
