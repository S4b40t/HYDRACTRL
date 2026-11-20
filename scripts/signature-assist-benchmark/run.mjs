import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { browserExecutable, classifyGpu, configuration } from "./platform.mjs";
import { sha256, startServer, stopServer } from "./server.mjs";
import { loadTargetedFixture } from "./targeted.mjs";

const config = configuration(process.env);
const root = fileURLToPath(new URL("../../", import.meta.url));
const browserScript = fileURLToPath(new URL("./browser.js", import.meta.url));
const url = `http://127.0.0.1:${config.port}`;
const bundleUrl = `${url}/assets/index.js`;
const bun = process.env.BUN || "bun";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const timing = { warmMs: config.warmMs, idleMs: config.idleMs, editMs: config.editMs };
const diagnosticTiming = { warmMs: timing.warmMs, idleMs: 1300, editMs: 1400 };

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

const fixtures = config.targeted
  ? [await loadTargetedFixture(config.fixturePath), fixture("stress", 520, 450)]
  : [fixture("small", 4, 4), fixture("medium", 70, 60), fixture("stress", 520, 450)];
const heapFixture = config.targeted ? fixtures[0] : fixtures[1];

async function cgroup(name) {
  if (process.platform !== "linux") return null;
  try {
    return (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const native = {
  label: "osc(frequency = 60, sync = 0.1, offset = 0)",
  active: "frequency = 60",
  summary: null,
  argument: null,
};
const custom = {
  label: "benchClamp(_value, min, max)",
  active: "min",
  summary: "Restricts a value to a specified range.",
  argument: "Lower bound.",
};

const raw = {
  schemaVersion: 2,
  status: "running",
  provenance: {
    url: `${url}/app`,
    config,
    testedRevision: git("rev-parse", "HEAD"),
    node: process.version,
    platform: process.platform,
    os: os.release(),
    cpu: os.cpus()[0]?.model,
    visibleCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    cpuMax: await cgroup("cpu.max"),
    memoryMax: await cgroup("memory.max"),
    cpuStatBefore: await cgroup("cpu.stat"),
    viewport: [1280, 720],
    playwrightVersion: JSON.parse(
      await readFile(path.join(root, "node_modules/playwright-core/package.json"), "utf8"),
    ).version,
  },
  fixtures,
  fixtureHashes: fixtures.map(({ size, setup, sketch, metadata }) => ({
    size,
    setupSha256: sha256(setup),
    sketchSha256: sha256(sketch),
    ...metadata,
  })),
  trials: [],
  diagnostics: [],
  heapTrials: [],
  preflight: [],
};
await mkdir(path.dirname(config.output), { recursive: true });
await writeFile(config.output, JSON.stringify(raw), { flag: "wx" });
console.log(`Results: ${config.output}`);
const temporary = await mkdtemp(path.join(os.tmpdir(), "hydractrl-bench-"));
const probe = path.join(temporary, "probe.js");
let probeHash;
let browser;
let server;
let interrupted = false;

function abort() {
  interrupted = true;
  server?.kill();
  if (browser) void browser.close().catch(() => {});
}
process.once("SIGINT", abort);
process.once("SIGTERM", abort);

function checkInterrupted() {
  if (interrupted) throw new Error("Benchmark interrupted");
}

async function verifyServer() {
  checkInterrupted();
  assert.ok(server?.exitCode === null && server.signalCode === null, "Benchmark server exited");
  const response = await fetch(bundleUrl, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Bundle request failed: ${response.status}`);
  const served = sha256(Buffer.from(await response.arrayBuffer()));
  assert.equal(served, raw.provenance.appBundleSha256, "Served bundle differs from local build");
  return served;
}

async function validateTooltip(page, expected, stress) {
  if (expected) {
    try {
      await page.waitForFunction(() => Boolean(window.signatureBenchmark.readHint()), null, {
        timeout: stress ? 1500 : 8000,
      });
    } catch (error) {
      if (!stress || error.name !== "TimeoutError") throw error;
    }
  }
  const actual = await page.evaluate(() => window.signatureBenchmark.readHint());
  if (!(stress && actual === null)) assert.deepEqual(actual, expected);
  return actual;
}

async function freshPage(context, diagnostic) {
  if (diagnostic) {
    await context.route(bundleUrl, (route) =>
      route.fulfill({ path: probe, contentType: "text/javascript" }),
    );
  }
  const page = await context.newPage();
  const errors = [];
  page.setDefaultTimeout(25_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript({ path: browserScript });
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url() === bundleUrl && response.ok()),
    page.goto(`${url}/app`),
  ]);
  assert.equal(
    sha256(await response.body()),
    diagnostic ? probeHash : raw.provenance.appBundleSha256,
    "Browser received unexpected bundle",
  );
  await page.waitForFunction(
    () => window.hydractrl?.plugins.getStatus("signature-assist") === "active",
  );
  return { page, errors };
}

function verifyGraphics(environment, label) {
  environment.graphics = classifyGpu(environment.webgl, raw.provenance.gpu);
  raw.preflight.push({ ...label, ...environment });
  if (
    config.mode === "hardware" &&
    (environment.graphics.classification !== "hardware" || !environment.pageVisible)
  ) {
    throw new Error(
      `HARDWARE PREFLIGHT FAILED: ${environment.graphics.classification}, visible=${environment.pageVisible}, renderer=${environment.webgl?.renderer}`,
    );
  }
  if (config.mode === "software" && environment.graphics.classification !== "software") {
    throw new Error(`Requested software renderer was not verified: ${environment.webgl?.renderer}`);
  }
}

async function trial(fixture, autoRun, enabled, diagnostic = false) {
  checkInterrupted();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  try {
    const { page, errors } = await freshPage(context, diagnostic);
    const environment = await page.evaluate((options) => window.signatureBenchmark.init(options), {
      fixture,
      enabled,
      autoRun,
      timing: diagnostic ? diagnosticTiming : timing,
    });
    verifyGraphics(environment, { fixture: fixture.size, enabled, autoRun, diagnostic });

    console.log(
      `${diagnostic ? "Diagnostic" : "Trial"} ${fixture.size}, plugin ${enabled ? "on" : "off"}, auto-run ${autoRun}, ${environment.graphics.classification}`,
    );
    const stress = fixture.size === "stress";
    const customHint = fixture.customHint ?? custom;
    await page.evaluate(() => window.signatureBenchmark.cold());
    const coldTooltip = await validateTooltip(page, enabled ? customHint : null, stress);
    const typing = [];
    for (let index = 0; index < 3; index++) {
      await page.evaluate((index) => window.signatureBenchmark.prepareTyping(index), index);
      await page.keyboard.type("2");
      const measured = await page.evaluate(() => window.signatureBenchmark.finishTyping());
      measured.settledTooltip = await validateTooltip(
        page,
        enabled ? (index ? customHint : native) : null,
        stress,
      );
      typing.push(measured);
    }
    const measurements = await page.evaluate(() => window.signatureBenchmark.run());
    const slotTooltip = await validateTooltip(page, enabled ? native : null, stress);
    assert.deepEqual(errors, []);
    assert.equal(measurements.modeAfter, enabled ? "active" : null);
    if (config.mode === "hardware") {
      assert.ok(
        !measurements.visibility.some(({ state }) => state !== "visible"),
        "Hardware benchmark page was hidden",
      );
    }
    assert.ok(measurements.phases.idle.draws > 0 && measurements.phases.editing.draws > 0);
    assert.ok(
      measurements.runs.some(({ phase }) => phase === "slot"),
      "Slot loading did not run a sketch",
    );
    assert.equal(
      measurements.runs.some(({ phase }) => phase === "after-edit" || phase === "editing"),
      autoRun,
    );
    if (fixture.setupScenarios) {
      for (const kind of Object.keys(fixture.setupScenarios).filter(
        (kind) => kind !== "recovery",
      )) {
        assert.equal(
          measurements.runs.some(
            ({ phase }) => phase === `setup-${kind}` || phase === `setup-after-${kind}`,
          ),
          autoRun,
          `Unexpected auto-run behavior during Setup ${kind} edits`,
        );
      }
    }
    if (!enabled) assert.ok(typing.every((item) => !item.tooltip));
    return {
      fixture: fixture.size,
      autoRun,
      enabled,
      environment,
      coldTooltip,
      typing,
      slotTooltip,
      ...measurements,
    };
  } finally {
    await context.close();
  }
}

async function memoryTrial(pair, control, snapshotDirectory) {
  checkInterrupted();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  try {
    const { page, errors } = await freshPage(context, true);
    const environment = await page.evaluate((options) => window.signatureBenchmark.init(options), {
      fixture: heapFixture,
      enabled: false,
      autoRun: false,
      timing: diagnosticTiming,
    });
    verifyGraphics(environment, { fixture: heapFixture.size, heap: true, pair, control });
    const cdp = await context.newCDPSession(page);
    async function heap() {
      await cdp.send("HeapProfiler.collectGarbage");
      return cdp.send("Runtime.getHeapUsage");
    }
    async function snapshot(label) {
      if (!snapshotDirectory) return;
      const arm = control ? "control" : "lifecycle";
      const output = path.join(snapshotDirectory, `${arm}-${label}.heapsnapshot`);
      const fd = openSync(output, "wx");
      const append = ({ chunk }) => writeSync(fd, chunk);
      cdp.on("HeapProfiler.addHeapSnapshotChunk", append);
      try {
        await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      } finally {
        cdp.off("HeapProfiler.addHeapSnapshotChunk", append);
        closeSync(fd);
      }
    }
    async function cycleOnce(cycle) {
      const installedState = await page.evaluate(
        (control) => window.signatureBenchmark.cycle(true, control),
        control,
      );
      installedState.hint = await validateTooltip(
        page,
        control ? null : (heapFixture.customHint ?? custom),
        false,
      );
      assert.equal(installedState.mode, control ? null : "active");
      const installed = await heap();
      const disposedState = await page.evaluate(
        (control) => window.signatureBenchmark.cycle(false, control),
        control,
      );
      assert.equal(disposedState.mode, null);
      assert.equal(disposedState.tooltip, false);
      if (config.targeted) {
        assert.deepEqual(installedState.extension, {
          field: !control,
          focus: !control,
          keys: !control,
        });
        assert.deepEqual(disposedState.extension, { field: false, focus: false, keys: false });
        assert.equal(disposedState.autoRun, true);
      }
      return { cycle, installed, disposed: await heap(), installedState, disposedState };
    }
    const beforeWarmup = await heap();
    await snapshot("initial");
    for (let cycle = 0; cycle < (config.targeted && !config.pilot ? 5 : 0); cycle++) {
      await cycleOnce(cycle);
    }
    const samples = [{ cycle: 0, disposed: await heap() }];
    await snapshot("warm");
    for (let cycle = 1; cycle <= config.heapCycles; cycle++) samples.push(await cycleOnce(cycle));
    await snapshot("disposed");
    assert.deepEqual(errors, []);
    return { pair, control, beforeWarmup, samples };
  } finally {
    await context.close();
  }
}

try {
  if (config.revision)
    assert.equal(
      raw.provenance.testedRevision,
      config.revision,
      "Checkout does not match BENCH_REVISION",
    );
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "Use a clean checkout");
  const executablePath = await browserExecutable(process.env);
  raw.provenance.executablePath = executablePath;
  raw.provenance.bun = execFileSync(bun, ["--version"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync(bun, ["run", "build"], { cwd: root, stdio: "inherit", windowsHide: true });
  raw.provenance.appBundleSha256 = sha256(
    await readFile(path.join(root, "public", "assets", "index.js")),
  );
  server = await startServer(bun, root, config.port);
  raw.provenance.servedBundleSha256 = await verifyServer();
  browser = await chromium.launch({
    executablePath,
    headless: config.headless,
    args: config.args,
    chromiumSandbox: config.mode === "hardware",
    ignoreDefaultArgs: config.mode === "hardware" ? ["--enable-unsafe-swiftshader"] : undefined,
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  raw.provenance.chromium = browser.version();
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { gpu } = await cdp.send("SystemInfo.getInfo");
    raw.provenance.gpu = gpu;
  } catch (error) {
    raw.provenance.gpuError = error.message;
  }
  try {
    const { arguments: browserArguments } = await cdp.send("Browser.getBrowserCommandLine");
    raw.provenance.graphicsFlags = browserArguments.filter((argument) =>
      /^--(?:[^=]*gpu|use-angle|use-gl|[^=]*swiftshader|no-sandbox|headless)/i.test(argument),
    );
  } catch (error) {
    raw.provenance.graphicsFlagsError = error.message;
  } finally {
    await cdp.detach();
  }

  if (config.stage !== "heap") {
    for (const fixture of fixtures) {
      for (const autoRun of fixture.size === "stress" ? [false] : [false, true]) {
        for (let pair = 0; pair < config.pairs; pair++) {
          for (const enabled of pair % 2 ? [true, false] : [false, true]) {
            raw.trials.push({ pair: pair + 1, ...(await trial(fixture, autoRun, enabled)) });
          }
          await verifyServer();
          await writeFile(config.output, JSON.stringify(raw));
        }
      }
    }
  }
  execFileSync(bun, ["scripts/signature-assist-benchmark/build-probe.mjs", probe], {
    cwd: root,
    windowsHide: true,
  });
  probeHash = sha256(await readFile(probe));
  raw.provenance.diagnosticBundleSha256 = probeHash;
  if (config.stage !== "heap") {
    for (const fixture of fixtures) {
      for (const autoRun of config.targeted && fixture.size === "real-setup"
        ? [false, true]
        : [false]) {
        raw.diagnostics.push(await trial(fixture, autoRun, true, true));
      }
    }
  }
  for (let pair = 0; pair < config.heapPairs; pair++) {
    for (const control of pair % 2 ? [false, true] : [true, false]) {
      raw.heapTrials.push(await memoryTrial(pair + 1, control));
      await writeFile(config.output, JSON.stringify(raw));
    }
  }
  if (config.snapshotDirectory) {
    await mkdir(config.snapshotDirectory, { recursive: true });
    raw.snapshotTrials = [];
    for (const control of [true, false]) {
      raw.snapshotTrials.push(await memoryTrial(1, control, config.snapshotDirectory));
    }
  }
  await verifyServer();
  raw.status = "complete";
} catch (error) {
  raw.status = "failed";
  raw.failure = error.message;
  console.error(error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  await Promise.allSettled([browser?.close(), stopServer(server)]);
  await rm(temporary, { recursive: true, force: true });
  raw.provenance.cpuStatAfter = await cgroup("cpu.stat");
  await writeFile(config.output, JSON.stringify(raw));
  console.log(`Benchmark ${raw.status}: ${config.output}`);
}
