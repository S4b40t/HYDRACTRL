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

function deltas(off, on) {
  return Object.fromEntries(
    ["median", "p95", "p99", "iqr", "fps", "longPercent"].flatMap((key) => {
      if (!Number.isFinite(off[key]) || !Number.isFinite(on[key])) return [];
      return [
        [
          key,
          {
            absolute: round(on[key] - off[key]),
            percent: round(((on[key] - off[key]) / off[key]) * 100),
          },
        ],
      ];
    }),
  );
}

function compare(trials, values, summarize = stats) {
  const off = trials.filter((trial) => !trial.enabled);
  const on = trials.filter((trial) => trial.enabled);
  const baseline = off.flatMap(values);
  const treatment = on.flatMap(values);
  const offP95 = quantile(baseline, 0.95);
  const onP95 = quantile(treatment, 0.95);
  const pairs = on.flatMap((trial) => {
    const control = off.find(({ pair }) => pair === trial.pair);
    if (!control || !values(control).length || !values(trial).length) return [];
    const baselineValues = values(control);
    const treatmentValues = values(trial);
    const offStats = summarize(baselineValues);
    const onStats = summarize(treatmentValues);
    const baselineP95 = quantile(baselineValues, 0.95);
    const treatmentP95 = quantile(treatmentValues, 0.95);
    return [
      {
        pair: trial.pair,
        off: offStats,
        on: onStats,
        deltas: deltas(offStats, onStats),
        deltaP95: round(treatmentP95 - baselineP95),
        deltaP95Percent: round((treatmentP95 / baselineP95 - 1) * 100),
      },
    ];
  });
  const offStats = summarize(baseline);
  const onStats = summarize(treatment);
  return {
    off: offStats,
    on: onStats,
    deltas: deltas(offStats, onStats),
    deltaP95: round(onP95 - offP95),
    deltaP95Percent: round(((onP95 - offP95) / offP95) * 100),
    pairs,
    pairedDeltaP95: pairs.map(({ deltaP95 }) => deltaP95),
    pairedOver5Percent: on.filter((trial) => {
      const control = off.find(({ pair }) => pair === trial.pair);
      return control && quantile(values(trial), 0.95) > 1.05 * quantile(values(control), 0.95);
    }).length,
  };
}

const groups = [];
const setupPhases = ["body", "parameter", "declaration", "jsdoc", "recovery"].map(
  (kind) => `setup-${kind}`,
);

function phaseData(trial, phase) {
  if (phase !== "setup-editing") return trial.phases[phase];
  return {
    intervalsMs: setupPhases.flatMap((name) => trial.phases[name].intervalsMs),
    durationMs: setupPhases.reduce((sum, name) => sum + trial.phases[name].durationMs, 0),
  };
}
for (const fixture of raw.fixtures) {
  for (const autoRun of [false, true]) {
    const trials = raw.trials.filter(
      (trial) => trial.fixture === fixture.size && trial.autoRun === autoRun,
    );
    if (!trials.length) continue;
    const availableSetupPhases = setupPhases.filter((phase) =>
      trials.some((trial) => trial.phases[phase]),
    );
    const dispatch = Object.fromEntries(
      ["cold", "cursor", "editing", "tab", "slot", ...availableSetupPhases].map((phase) => [
        phase,
        compare(trials, (trial) => trial.phases[phase]?.dispatchMs ?? []),
      ]),
    );
    const frameTiming = Object.fromEntries(
      [
        "idle",
        "editing",
        "after-edit",
        ...(availableSetupPhases.length ? ["setup-editing", ...availableSetupPhases] : []),
      ].map((phase) => [
        phase,
        compare(trials, (trial) => phaseData(trial, phase)?.intervalsMs ?? [], frames),
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
          tooltipSettled: trials.filter(
            (trial) => trial.enabled && trial.typing[index].settledTooltip,
          ).length,
        },
      ]),
    );
    const sketchOperations = availableSetupPhases.length
      ? Object.fromEntries(
          ["native", "custom", "nested"].map((name) => [
            name,
            compare(trials, (trial) => trial.phases.editing.operations?.[name] ?? []),
          ]),
        )
      : undefined;
    groups.push({
      fixture: fixture.size,
      autoRun,
      trials: trials.length,
      dispatch,
      frameTiming,
      typing,
      sketchOperations,
    });
  }
}

const cache = raw.diagnostics.map((trial) => ({
  fixture: trial.fixture,
  autoRun: trial.autoRun,
  phases: Object.fromEntries(
    ["cold", "cursor", "editing", "tab", "slot"].map((phase) => [
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
  components: summarizeComponents(trial.cache),
}));

function summarizeComponents(events) {
  const groups = new Map();
  for (const { phase, kind, tab, operation, ms } of events) {
    const key = JSON.stringify([phase, tab ?? null, operation ?? null, kind]);
    if (!groups.has(key)) groups.set(key, { phase, tab, operation, kind, count: 0, timings: [] });
    const group = groups.get(key);
    group.count++;
    if (Number.isFinite(ms)) group.timings.push(ms);
  }
  return [...groups.values()].map(({ timings, ...group }) => ({ ...group, ...stats(timings) }));
}
const heapSamples = (samples) =>
  samples.map((sample) => ({
    cycle: sample.cycle,
    disposedKiB: round(sample.disposed.usedSize / 1024),
    installedKiB: round(sample.installed?.usedSize / 1024),
    installedMinusDisposedKiB: round(
      (sample.installed?.usedSize - sample.disposed.usedSize) / 1024,
    ),
  }));

function referenceCadence(trial) {
  return Object.fromEntries(
    ["idle", "editing", ...(trial.phases["setup-body"] ? ["setup-editing"] : [])].map((phase) => {
      const data = phaseData(trial, phase);
      const result = frames(data.intervalsMs);
      const minimumSamples = Math.max(600, Math.floor(data.durationMs * 0.05));
      const stable =
        result.n >= minimumSamples &&
        result.fps >= 58 &&
        result.fps <= 62 &&
        result.median >= 15.5 &&
        result.median <= 17.8 &&
        result.longPercent <= 1;
      return [phase, { ...result, minimumSamples, stable }];
    }),
  );
}

const reference = raw.trials
  .filter((trial) => !trial.enabled && trial.fixture !== "stress")
  .map((trial) => ({
    fixture: trial.fixture,
    autoRun: trial.autoRun,
    pair: trial.pair,
    ...referenceCadence(trial),
  }));
const treatmentSamples = raw.trials
  .filter((trial) => trial.enabled && trial.fixture !== "stress")
  .map((trial) => ({
    fixture: trial.fixture,
    autoRun: trial.autoRun,
    pair: trial.pair,
    ...referenceCadence(trial),
  }));
const eligibility =
  raw.status === "complete" &&
  raw.provenance.config?.mode === "hardware" &&
  ["full", "targeted"].includes(raw.provenance.config?.profile) &&
  reference.length === (raw.provenance.config.targeted ? 2 : 4) * raw.provenance.config.pairs &&
  reference.every(
    ({ idle, editing, "setup-editing": setup }) =>
      idle.stable && editing.stable && (!setup || setup.stable),
  ) &&
  treatmentSamples.length === reference.length &&
  treatmentSamples.every(
    ({ idle, editing, "setup-editing": setup }) =>
      idle.n >= idle.minimumSamples &&
      editing.n >= editing.minimumSamples &&
      (!setup || setup.n >= setup.minimumSamples),
  );
const representative = groups.filter((group) => group.fixture !== "stress");
const editorFlags = representative.flatMap((group) => {
  const operations = {
    editing: group.dispatch.editing,
    ...Object.fromEntries(
      setupPhases
        .filter((phase) => group.dispatch[phase])
        .map((phase) => [phase, group.dispatch[phase]]),
    ),
    ...Object.fromEntries(
      Object.entries(group.sketchOperations ?? {}).map(([name, value]) => [
        `sketch-${name}`,
        value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(group.typing).map(([name, value]) => [name, value.dispatch]),
    ),
  };
  return Object.entries(operations)
    .filter(([, result]) => result.deltaP95 > 2)
    .map(([operation, result]) => ({
      fixture: group.fixture,
      autoRun: group.autoRun,
      operation,
      deltaP95: result.deltaP95,
    }));
});
const frameFlags = representative.flatMap((group) =>
  Object.entries(group.frameTiming)
    .filter(
      ([phase, result]) =>
        ["idle", "editing", "setup-editing"].includes(phase) &&
        result.pairedOver5Percent >= Math.ceil((group.trials / 2) * 0.8),
    )
    .map(([phase, result]) => ({
      fixture: group.fixture,
      autoRun: group.autoRun,
      phase,
      pairsOver5Percent: result.pairedOver5Percent,
    })),
);
const heapTrials = (raw.heapTrials ?? []).map(({ pair, control, samples, beforeWarmup }) => ({
  pair,
  control,
  samples: heapSamples(samples),
  beforeWarmupKiB: round(beforeWarmup?.usedSize / 1024),
  postGcGrowthKiB: round((samples.at(-1).disposed.usedSize - samples[0].disposed.usedSize) / 1024),
}));

console.log(
  JSON.stringify(
    {
      experimentStatus: raw.status ?? "historical",
      failure: raw.failure ?? null,
      mode: raw.provenance.config?.mode ?? "historical",
      profile: raw.provenance.config?.profile,
      fixtureHashes: raw.fixtureHashes,
      reference60Hz: {
        status: eligibility ? "eligible-for-review" : "inconclusive",
        controls: reference,
        treatmentSamples,
      },
      representativeReviewFlags: {
        editorOver2ms: editorFlags,
        repeatableFrameP95Over5Percent: frameFlags,
      },
      groups,
      cache,
      heapTrials,
      memory: heapSamples(raw.memory ?? []),
      memoryControl: heapSamples(raw.memoryControl ?? []),
    },
    null,
    2,
  ),
);
