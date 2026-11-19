import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const pairs = Number(process.env.PAIRS || 5);
const output = process.env.BENCH_OUTPUT || "/tmp/hydractrl-signature-benchmark.json";
const baseUrl = process.env.HYDRACTRL_URL || "http://127.0.0.1:3000/app";
const browserScript = new URL("./browser.js", import.meta.url).pathname;
const temporary = await mkdtemp(path.join(os.tmpdir(), "hydractrl-bench-"));
const probe = path.join(temporary, "probe.js");

function fixture(size, setupExtra, sketchExtra) {
  const helpers = (prefix, count) =>
    Array.from({ length: count }, (_, index) =>
      [
        `/** Shape sample ${index}. */`,
        `const ${prefix}${index} = (x, amount = 0.5) => Math.sin(x + ${index}) * amount;`,
      ].join("\n"),
    ).join("\n");
  return {
    size,
    setup: [
      "/**",
      " * Restricts a value to a specified range.",
      " * @param {number} _value - Input value.",
      " * @param {number} min - Lower bound.",
      " * @param {number} max - Upper bound.",
      " */",
      "const benchClamp = (_value, min, max) => Math.min(Math.max(_value, min), max);",
      "const benchSetupCall = () => benchClamp(0.4, 0.1, 0.9);",
      helpers("setupHelper", setupExtra),
    ]
      .filter(Boolean)
      .join("\n"),
    sketch: [
      "const sampleNative = () => osc(11, 0.1, 0).rotate(0.1).color(0.8, 0.4, 0.7);",
      "const sampleCustom = () => benchClamp(0.5, 11, 20);",
      "const sampleNested = () => osc(benchClamp(0.5, 11, 20), 0.1).out();",
      "const benchmarkScene = osc(12, 0.06, 0.7).modulate(noise(3, 0.2), 0.06).rotate(0.2, 0.05).color(0.7, 0.4, 0.9);",
      "benchmarkScene.out(o0);",
      helpers("sketchHelper", sketchExtra),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

const fixtures = [fixture("small", 4, 4), fixture("medium", 70, 60), fixture("stress", 520, 450)];
const cgroup = async (name) => {
  try {
    return (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
};
const executablePath = process.env.CHROMIUM || "/usr/bin/chromium";
const args = ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ executablePath, args, headless: true });
let raw = {
  provenance: {
    url: baseUrl,
    testedRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    appBundleSha256: createHash("sha256")
      .update(await readFile("public/assets/index.js"))
      .digest("hex"),
    chromium: browser.version(),
    node: process.version,
    bun: execFileSync(process.env.BUN || "bun", ["--version"], { encoding: "utf8" }).trim(),
    os: os.version(),
    cpu: os.cpus()[0]?.model,
    visibleCpus: os.cpus().length,
    cpuMax: await cgroup("cpu.max"),
    memoryMax: await cgroup("memory.max"),
    cpuStatBefore: await cgroup("cpu.stat"),
    viewport: [1280, 720],
    launchFlags: args,
    pairs,
    playwrightVersion: JSON.parse(
      await readFile("node_modules/playwright-core/package.json", "utf8"),
    ).version,
  },
  fixtures,
  trials: [],
  diagnostics: [],
  memory: [],
  memoryControl: [],
};

async function trial(fixture, autoRun, enabled, diagnostic = false) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  try {
    if (diagnostic) {
      await context.route("**/assets/index.js", (route) =>
        route.fulfill({ path: probe, contentType: "text/javascript" }),
      );
    }
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript({ path: browserScript });
    await page.goto(baseUrl);
    await page.waitForFunction(
      () => window.hydractrl?.plugins.getStatus("signature-assist") === "active",
    );
    const environment = await page.evaluate((config) => window.signatureBenchmark.init(config), {
      fixture,
      enabled,
      autoRun,
    });
    const typing = [];
    for (let index = 0; index < 3; index++) {
      await page.evaluate((i) => window.signatureBenchmark.prepareTyping(i), index);
      await page.keyboard.type("2");
      typing.push(await page.evaluate(() => window.signatureBenchmark.finishTyping()));
    }
    const measurements = await page.evaluate(() => window.signatureBenchmark.run());
    assert.deepEqual(errors, []);
    assert.ok(measurements.phases.idle.draws > 0 && measurements.phases.editing.draws > 0);
    assert.equal(
      measurements.runs.some(({ phase }) => phase === "after-edit" || phase === "editing"),
      autoRun,
    );
    if (!enabled) assert.ok(typing.every((item) => !item.tooltip));
    return { fixture: fixture.size, autoRun, enabled, environment, typing, ...measurements };
  } finally {
    await context.close();
  }
}

async function memoryTrials(control) {
  const samples = control ? raw.memoryControl : raw.memory;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    await context.route("**/assets/index.js", (route) =>
      route.fulfill({ path: probe, contentType: "text/javascript" }),
    );
    const page = await context.newPage();
    await page.addInitScript({ path: browserScript });
    await page.goto(baseUrl);
    await page.waitForFunction(
      () => window.hydractrl?.plugins.getStatus("signature-assist") === "active",
    );
    await page.evaluate(
      (fixture) => window.signatureBenchmark.init({ fixture, enabled: false, autoRun: false }),
      fixtures[1],
    );
    const cdp = await context.newCDPSession(page);
    async function heap() {
      await cdp.send("HeapProfiler.collectGarbage");
      return cdp.send("Runtime.getHeapUsage");
    }
    samples.push({ cycle: 0, disposed: await heap() });
    for (let cycle = 1; cycle <= 10; cycle++) {
      const installedState = await page.evaluate(
        (off) => window.signatureBenchmark.cycle(true, off),
        control,
      );
      if (!control) {
        await page.waitForFunction(() => Boolean(document.querySelector(".cm-signature-assist")));
        installedState.tooltip = true;
      }
      assert.equal(installedState.mode, control ? null : "active");
      const installed = await heap();
      const disposedState = await page.evaluate(
        (off) => window.signatureBenchmark.cycle(false, off),
        control,
      );
      assert.equal(installedState.tooltip, !control);
      assert.equal(disposedState.tooltip, false);
      samples.push({ cycle, installed, disposed: await heap(), installedState, disposedState });
    }
  } finally {
    await context.close();
  }
}

const appendControl = process.env.BENCH_APPEND_MEMORY_CONTROL === "1";
try {
  if (appendControl) {
    const existing = JSON.parse(await readFile(output, "utf8"));
    assert.equal(existing.provenance.appBundleSha256, raw.provenance.appBundleSha256);
    assert.equal(existing.provenance.chromium, raw.provenance.chromium);
    raw = existing;
    raw.memoryControl = [];
  } else {
    for (const fixture of fixtures) {
      for (const autoRun of fixture.size === "stress" ? [false] : [false, true]) {
        for (let pair = 0; pair < pairs; pair++) {
          for (const enabled of pair % 2 ? [true, false] : [false, true]) {
            raw.trials.push({ pair: pair + 1, ...(await trial(fixture, autoRun, enabled)) });
          }
          await writeFile(output, JSON.stringify(raw));
          console.log(`Completed ${fixture.size}, auto-run ${autoRun}: pair ${pair + 1}/${pairs}`);
        }
      }
    }
  }
  execFileSync(process.env.BUN || "bun", [
    "scripts/signature-assist-benchmark/build-probe.mjs",
    probe,
  ]);
  if (!appendControl) {
    for (const fixture of fixtures) {
      raw.diagnostics.push(await trial(fixture, false, true, true));
      console.log(`Cache probe: ${fixture.size}`);
    }
    await memoryTrials(false);
    raw.provenance.cpuStatAfter = await cgroup("cpu.stat");
  }
  raw.provenance.memoryControlCpuBefore = await cgroup("cpu.stat");
  await memoryTrials(true);
  raw.provenance.memoryControlCpuAfter = await cgroup("cpu.stat");
  console.log("Completed ten memory control cycles");
} finally {
  if (!appendControl) raw.provenance.cpuStatAfter ??= await cgroup("cpu.stat");
  if (!appendControl || raw.memoryControl.length) await writeFile(output, JSON.stringify(raw));
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
