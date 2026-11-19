import { readFile } from "node:fs/promises";

const raw = JSON.parse(await readFile(process.argv[2], "utf8"));
const quantile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(3)) : null);

function stats(values) {
  return {
    n: values.length,
    median: round(quantile(values, 0.5)),
    p95: round(quantile(values, 0.95)),
    p99: round(quantile(values, 0.99)),
    iqr: round(quantile(values, 0.75) - quantile(values, 0.25)),
  };
}

function frames(values) {
  return {
    ...stats(values),
    fps: round((values.length * 1000) / values.reduce((total, interval) => total + interval, 0)),
    longPercent: round((values.filter((interval) => interval > 25).length / values.length) * 100),
    estimatedMissed60Hz: values.reduce(
      (total, interval) => total + Math.max(0, Math.round(interval / (1000 / 60)) - 1),
      0,
    ),
  };
}

function compare(trials, values, summarize = stats) {
  const off = trials.filter((trial) => !trial.enabled);
  const on = trials.filter((trial) => trial.enabled);
  const baseline = off.flatMap(values);
  const treatment = on.flatMap(values);
  const offP95 = quantile(baseline, 0.95);
  const onP95 = quantile(treatment, 0.95);
  const pairDeltas = on.flatMap((trial) => {
    const control = off.find(({ pair }) => pair === trial.pair);
    if (!control || !values(control).length || !values(trial).length) return [];
    return [quantile(values(trial), 0.95) - quantile(values(control), 0.95)];
  });
  return {
    off: summarize(baseline),
    on: summarize(treatment),
    deltaP95: round(onP95 - offP95),
    deltaP95Percent: round(((onP95 - offP95) / offP95) * 100),
    pairedDeltaP95: pairDeltas.map(round),
    pairedOver5Percent: on.filter((trial) => {
      const control = off.find(({ pair }) => pair === trial.pair);
      return control && quantile(values(trial), 0.95) > 1.05 * quantile(values(control), 0.95);
    }).length,
  };
}

const groups = [];
for (const fixture of raw.fixtures) {
  for (const autoRun of [false, true]) {
    const trials = raw.trials.filter(
      (trial) => trial.fixture === fixture.size && trial.autoRun === autoRun,
    );
    if (!trials.length) continue;
    const dispatch = Object.fromEntries(
      ["cursor", "editing", "tab", "slot"].map((phase) => [
        phase,
        compare(trials, (trial) => trial.phases[phase].dispatchMs),
      ]),
    );
    const frameTiming = Object.fromEntries(
      ["idle", "editing", "after-edit"].map((phase) => [
        phase,
        compare(trials, (trial) => trial.phases[phase].intervalsMs, frames),
      ]),
    );
    const typing = Object.fromEntries(
      ["native", "custom", "nested"].map((name, index) => [
        name,
        {
          dispatch: compare(trials, (trial) => trial.phases[`typing-${index}`].dispatchMs),
          firstRaf: compare(trials, (trial) =>
            [trial.typing[index].firstRafMs].filter(Number.isFinite),
          ),
          secondRaf: compare(trials, (trial) =>
            [trial.typing[index].secondRafMs].filter(Number.isFinite),
          ),
          tooltipDom: stats(
            trials
              .filter((trial) => trial.enabled)
              .map((trial) => trial.typing[index].tooltipDomMs)
              .filter(Number.isFinite),
          ),
          tooltipVisible: trials.filter((trial) => trial.enabled && trial.typing[index].tooltip)
            .length,
        },
      ]),
    );
    groups.push({
      fixture: fixture.size,
      autoRun,
      trials: trials.length,
      dispatch,
      frameTiming,
      typing,
    });
  }
}

const cache = raw.diagnostics.map((trial) => ({
  fixture: trial.fixture,
  phases: Object.fromEntries(
    ["cursor", "editing", "tab", "slot"].map((phase) => [
      phase,
      Object.fromEntries(
        ["active", "inactive"].map((kind) => [
          kind,
          stats(
            trial.cache
              .filter((event) => event.phase === phase && event.kind === kind)
              .map(({ ms }) => ms),
          ),
        ]),
      ),
    ]),
  ),
}));
const heapSamples = (samples) =>
  samples.map((sample) => ({
    cycle: sample.cycle,
    disposedKiB: round(sample.disposed.usedSize / 1024),
    installedKiB: round(sample.installed?.usedSize / 1024),
    installedMinusDisposedKiB: round(
      (sample.installed?.usedSize - sample.disposed.usedSize) / 1024,
    ),
  }));

console.log(
  JSON.stringify(
    {
      groups,
      cache,
      memory: heapSamples(raw.memory),
      memoryControl: heapSamples(raw.memoryControl ?? []),
    },
    null,
    2,
  ),
);
