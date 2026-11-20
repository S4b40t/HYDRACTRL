import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

async function read(path) {
  const bytes = await readFile(path);
  return JSON.parse(path.endsWith(".gz") ? gunzipSync(bytes) : bytes);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return values.length
    ? {
        n: sorted.length,
        median: rank(0.5),
        p95: rank(0.95),
        p99: rank(0.99),
        iqr: rank(0.75) - rank(0.25),
      }
    : { n: 0 };
}

function group(batches) {
  const groups = new Map();
  for (const batch of batches) {
    const key = `${batch.fixture}/${batch.scenario}/${batch.complete ? "complete" : "natural"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(batch);
  }
  return groups;
}

function total(sample) {
  return sample.updateMs + (sample.recoveryMs ?? 0);
}

function timings(samples) {
  const ready = samples.filter((sample) => sample.ready);
  const recovered = samples.filter((sample) => sample.recoveryMs !== undefined);
  return {
    updates: stats(samples.map(({ updateMs }) => updateMs)),
    readyUpdates: stats(ready.map(({ updateMs }) => updateMs)),
    deferred: samples.length - ready.length,
    forcedRecovery: stats(recovered.map(({ recoveryMs }) => recoveryMs)),
    total: stats(samples.map(total)),
    verifiedHintOutcomes: ready.length + recovered.length,
  };
}

const paired = await read(process.argv[2]);
const instrumented = await read(process.argv[3]);
const transactions = Object.fromEntries(
  [...group(paired.batches)].map(([key, batches]) => {
    const baseline = batches.filter((batch) => !batch.enabled);
    const treatment = batches.filter((batch) => batch.enabled);
    const off = timings(baseline.flatMap((batch) => batch.samples));
    const on = timings(treatment.flatMap((batch) => batch.samples));
    const pairDeltas = treatment.map((batch) => {
      const control = baseline.find(({ pair }) => pair === batch.pair);
      return stats(batch.samples.map(total)).p95 - stats(control.samples.map(total)).p95;
    });
    return [
      key,
      {
        off,
        on,
        p95DeltaMs: on.total.p95 - off.total.p95,
        pairedP95DeltasMs: pairDeltas,
      },
    ];
  }),
);
const cache = Object.fromEntries(
  [...group(instrumented.batches)].map(([key, batches]) => {
    const samples = batches.flatMap((batch) => batch.samples);
    return [
      key,
      {
        samples: samples.length,
        deferred: samples.filter(({ ready }) => !ready).length,
        ...Object.fromEntries(
          ["initialBuilds", "recoveryBuilds"].map((stage) => [
            stage,
            Object.fromEntries(
              ["active", "inactive"].map((kind) => [
                kind,
                stats(
                  samples.flatMap((sample) =>
                    (sample[stage] ?? []).filter(([name]) => name === kind).map(([, ms]) => ms),
                  ),
                ),
              ]),
            ),
          ]),
        ),
      },
    ];
  }),
);
const components = instrumented.direct.map(({ size, operation, values }) => ({
  size,
  operation,
  ...stats(values),
}));
console.log(JSON.stringify({ transactions, cache, components }, null, 2));
