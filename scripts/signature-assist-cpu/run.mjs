import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { history } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { forceParsing, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { showTooltip } from "@codemirror/view";
import { cacheProbe, installProbe } from "./probe.mjs";
import { scenarios } from "./scenarios.mjs";

const probe = process.argv.includes("--probe");
if (probe) installProbe();
const { signatureExtension } = await import("../../src/client/plugins/SignatureAssistPlugin.js");

const pairs = Number(process.env.PAIRS ?? 6);
const repeats = Number(process.env.REPEATS ?? 24);
assert.ok(Number.isInteger(pairs) && pairs > 0 && Number.isInteger(repeats) && repeats > 0);
const artifact = new URL(
  "../../docs/benchmarks/signature-assist-swiftshader.json",
  import.meta.url,
);
const { fixtures } = JSON.parse(await readFile(artifact, "utf8"));

const status = (state) =>
  syntaxTreeAvailable(state) && syntaxTree(state).length === state.doc.length;

function changeBetween(old, next, wholeDocument) {
  if (wholeDocument) return { from: 0, to: old.length, insert: next };
  if (old === next) return undefined;
  let from = 0;
  while (from < old.length && from < next.length && old[from] === next[from]) from++;
  let to = old.length;
  let end = next.length;
  while (to > from && end > from && old[to - 1] === next[end - 1]) {
    to--;
    end--;
  }
  return { from, to, insert: next.slice(from, end) };
}

function batch(scenario, enabled, complete, count) {
  const { a, b } = scenario;
  const sources = { main: scenario.sketch, setup: scenario.setup };
  sources[a.tab] = a.source;
  let tab = a.tab;
  const editor = { getCurrentTab: () => tab, getTabCode: (name) => sources[name] };
  const extensions = [javascript(), history(), EditorState.tabSize.of(2)];
  if (enabled) extensions.push(signatureExtension(editor));
  let state = EditorState.create({ doc: a.source, extensions });
  const mockView = {
    get state() {
      return state;
    },
    dispatch(spec) {
      state = state.update(spec).state;
    },
  };
  function finishParse() {
    return forceParsing(mockView, state.doc.length, 5000);
  }

  if (complete) assert.ok(finishParse());
  state = state.update({ selection: { anchor: a.anchor } }).state;
  if (complete && !status(state)) assert.ok(finishParse());
  // Prepare both caches in the tab scenario, under the same editor state path.
  function move(from, to) {
    tab = to.tab;
    sources[from.tab] = from.source;
    sources[to.tab] = to.source;
    return {
      changes: changeBetween(from.source, to.source, scenario.replaceDocument),
      selection: { anchor: to.anchor },
    };
  }

  const forward = move(a, b);
  const backward = move(b, a);
  const samples = [];
  for (let index = 0; index < count + 8; index++) {
    const reverse = index % 2 === 1;
    const target = reverse ? a : b;
    const from = reverse ? b : a;
    tab = target.tab;
    sources[from.tab] = from.source;
    sources[target.tab] = target.source;

    cacheProbe.length = 0;
    const started = performance.now();
    state = state.update(reverse ? backward : forward).state;
    const [initial] = state.facet(showTooltip);
    const ready = status(state);
    const updateMs = performance.now() - started;
    const initialBuilds = probe ? cacheProbe.slice() : undefined;

    let recoveryMs;
    if (complete && !ready) {
      cacheProbe.length = 0;
      const beforeRecovery = performance.now();
      const recovered = finishParse();
      state.facet(showTooltip);
      recoveryMs = performance.now() - beforeRecovery;
      assert.ok(recovered && status(state));
    }
    const [tip] = state.facet(showTooltip);
    const param = tip?.params[tip.active];
    const actual = tip
      ? [tip.name, param?.name ?? null, param?.documentation ?? null, tip.description ?? null]
      : null;
    const expected = enabled && (ready || complete) ? target.expected : null;
    assert.deepEqual(actual, expected, `${scenario.name}, enabled=${enabled}, ready=${ready}`);
    if (!ready)
      assert.equal(initial ?? null, null, `${scenario.name} disclosed a hint before full parsing`);

    if (index >= 8) {
      samples.push({
        updateMs,
        ready,
        recoveryMs,
        expectedHint: Boolean(target.expected),
        initialBuilds,
        recoveryBuilds: probe && recoveryMs !== undefined ? cacheProbe.slice() : undefined,
      });
    }
  }
  return samples;
}

async function directProbes() {
  const { indexCustomSignatures, createCustomSignatureResolver } = await import(
    "../../src/client/plugins/customSignatures.js"
  );
  const { hydraCallAtCursor } = await import("../../src/client/plugins/hydraSignature.js");
  const parser = javascript().language.parser;
  const results = [];

  for (const { size, setup, sketch } of fixtures) {
    const tree = parser.parse(sketch);
    const setupTree = parser.parse(setup);
    const stateFixture = {
      state: EditorState.create({
        doc: sketch,
        selection: { anchor: sketch.indexOf("benchClamp(0.5, 11") + "benchClamp(0.5, 11".length },
        extensions: [javascript()],
      }),
    };
    forceParsing(
      {
        get state() {
          return stateFixture.state;
        },
        dispatch(spec) {
          stateFixture.state = stateFixture.state.update(spec).state;
        },
      },
      sketch.length,
      5000,
    );
    assert.ok(status(stateFixture.state));
    const lookup = createCustomSignatureResolver({
      getCurrentTab: () => "main",
      getTabCode: () => setup,
    });
    assert.equal(
      hydraCallAtCursor(stateFixture.state, lookup(stateFixture.state)).name,
      "benchClamp",
    );

    for (const [operation, run] of [
      ["active-index", () => indexCustomSignatures(sketch, tree)],
      ["active-index-setup", () => indexCustomSignatures(setup, setupTree)],
      ["inactive-cold", () => indexCustomSignatures(setup, parser.parse(setup))],
      ["cached-lookup", () => hydraCallAtCursor(stateFixture.state, lookup(stateFixture.state))],
    ]) {
      const values = [];
      for (let bucket = 0; bucket < 6; bucket++) {
        Bun.gc(true);
        for (let sample = 0; sample < 28; sample++) {
          const start = performance.now();
          const result = run();
          const duration = performance.now() - start;
          assert.ok(result);
          if (sample >= 8) values.push(duration);
        }
      }
      results.push({ size, operation, values });
    }
  }
  return results;
}

async function cgroup(file) {
  try {
    return (await readFile(`/sys/fs/cgroup/${file}`, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const versions = {};
for (const name of [
  "@codemirror/state",
  "@codemirror/language",
  "@codemirror/lang-javascript",
  "@lezer/common",
  "@lezer/javascript",
  "@lezer/lr",
]) {
  versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8")).version;
}

const raw = {
  environment: {
    bun: Bun.version,
    os: os.release(),
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    cpuMax: await cgroup("cpu.max"),
    memoryMax: await cgroup("memory.max"),
    cpuBefore: await cgroup("cpu.stat"),
    versions,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    pairs,
    repeats,
    probe,
  },
  batches: [],
};
for (const fixture of fixtures) {
  for (const scenario of scenarios(fixture)) {
    for (const complete of [false, true]) {
      for (let pair = 0; pair < pairs; pair++) {
        for (const enabled of probe ? [true] : pair % 2 ? [true, false] : [false, true]) {
          Bun.gc(true);
          raw.batches.push({
            fixture: fixture.size,
            scenario: scenario.name,
            complete,
            pair,
            enabled,
            samples: batch(scenario, enabled, complete, repeats),
          });
        }
      }
    }
  }
  console.log(`Completed ${fixture.size}${probe ? " instrumented" : ""}`);
}
if (probe) raw.direct = await directProbes();
raw.environment.cpuAfter = await cgroup("cpu.stat");
await writeFile(
  process.env.BENCH_OUTPUT ??
    (probe ? "/tmp/hydractrl-cpu-probes.json" : "/tmp/hydractrl-cpu.json"),
  JSON.stringify(raw),
);
